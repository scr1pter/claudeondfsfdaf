export * as ResearchOutbound from "./outbound"

import { isIP } from "node:net"
import { domainToUnicode } from "node:url"
import { parse } from "tldts"
import { BrainScan } from "../brain/scan"
import { ResearchCanonical } from "./canonical"
import { WebFence } from "./fence"
import { ResearchWords } from "./words"

// The check on every search query and address research sends out (section 5.4). It checks for private text copied
// into a query by accident, and refuses a query only on a high-confidence signal, so ordinary research queries go out.
// A query or an address is refused when it holds:
// 1. a secret: a password, key or token that BrainScan finds by its shape, its name or a word beside it, or a value
//    BrainScan finds in the private context ("S3cretPassw0rd" from DB_PASSWORD=S3cretPassw0rd), whole: in the private
//    facts by its shape, its name or the words around it, and in the work only by its shape, an assignment, an
//    address's password, a login pair or "the password is X";
// 2. a run of RUN_WORDS words in a row that the private facts hold, or of WORK_RUN_WORDS that the work holds, not all
//    of them common words;
// 3. an email address, or a phone, card or account number (9 or more digits), from the private facts;
// 4. a private host from the private context: an intranet name (jira.acme.internal, build01.corp.lan), a private or
//    link-local IP address, or a host whose labels look internal (billing.acme-internal.io, db01.acme.io, and
//    jira.acme.com when the private facts have an email address at acme.com);
// 5. a local path in the user's home folder (/Users/<name>/, C:\Users\<name>\, ~<name>/), or with the user name as
//    one of its parts (D:\backup\<name>\ledger.db), or the working tree's own path when it has MIN_TREE_PARTS parts
//    or more. The user names are those of the home folder and working tree the run names (Context.home) and of the
//    home folders the private facts name; repository text names none.
// The user's typing clears any of 2 to 5, a public source of this run clears 2 and 3 (`strict` keeps a public source
// from clearing a number), and a search result on a host clears a host that only its labels made look internal.
// Nothing clears a secret, except one that only a word whose letters digits break up, in a sentence of the private
// facts about credentials, gave away ("claude-sonnet-4-5" of "sign in with Google, then route to claude-sonnet-4-5"):
// the user's typing or a public source that holds it whole clears that. Nothing else is refused: names of people and
// companies, identifiers, checksums and IDs the private context does not hold, public host names, the standard names
// and addresses of Docker, Kubernetes, cloud metadata, emulators and home networks, and numbers other than those of 3
// (dates, versions, years, quarters, ports, amounts) all go out.
//
// Its scope is copying, so some private text goes out by design: a copy shorter than RUN_WORDS words or made only of
// common words ("my wife is pregnant and due next month"), and a password that is one plain word ("swordfish"), since
// code gives such words to secret-sounding names as often ("password = hashed"). A long quote of a repository file or
// of tool output, such as an error message, is refused until a public source of the run holds it.
//
// It does not chase private text an agent encodes on purpose (digits spread over words, respellings) or paraphrases.
// Deliberate leaks are limited by how a run is built instead: an address must come from a search result, a page link
// or the user's text, researchers in Deep carry no private context, and memory writes are held after web content. The
// queries go to a search engine in the calling agent's own research browser and are shown in the Sources tab.
//
// Both sides are compared folded: NFKD without accents and invisible characters, any script's digits as ASCII, letters
// that look like Latin ones as Latin (WebFence.latin), and in lower case.

export const REFUSAL = "That search would send text from your private files. Rephrase it with public terms."

/** The run of consecutive words from the private facts that is refused on its own. */
export const RUN_WORDS = 8
/**
 * The run of consecutive words from the work that is refused on its own: longer, since a query may quote an error
 * message, a README or a licence that a repository file or a command's output holds, and the web holds as well.
 */
export const WORK_RUN_WORDS = 12

export type Context = {
  /**
   * Private facts loaded in this run: personal fact lines, MEMORY.md, private document passages, pages read signed
   * in, entries marked private, and decision and lesson lines. Text whose kind is not known belongs here.
   */
  readonly private: readonly string[]
  /**
   * The rest of the private text: repository files read, tool output, how-you-work preferences and RULES.md. Its
   * secrets, runs of words and private hosts are checked, and its email addresses, numbers and home folders are not.
   */
  readonly work?: readonly string[]
  /**
   * Paths that name the user's own account: the home folder and the run's working tree. The user names in them, with
   * those of the home folders the private facts name, are the names local paths are read for, and a path of them with
   * MIN_TREE_PARTS parts or more is refused whole (rule 5).
   */
  readonly home?: readonly string[]
  /**
   * The addresses of this run's search results. A host whose labels only look internal goes out once a result is on
   * it, since the web has shown it to be public.
   */
  readonly results?: readonly string[]
  /**
   * What the user typed or pasted in this run's root session. A launching agent's text (a sub-question, a task) is not
   * typed.
   */
  readonly typed: readonly string[]
  /** Public text seen in this run: search results and the pages read. */
  readonly public: readonly string[]
  /**
   * Domains the user chose to prefer or avoid: the sources facet's (section 6.4a), and the plan's once the user
   * approved it. They become site: filters, so a search query may send one as a host name even when it looks internal.
   * Only host names on a public suffix count, and `address` exempts none.
   */
  readonly domains?: readonly string[]
}

export type Reason = "secret" | "words" | "token"

export type Result =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: Reason; readonly match: string; readonly message: string }

const list = (text: string) => new Set(text.split(/\s+/).filter(Boolean))
// Function words, which ResearchWords.common leaves out. A run made only of these and common words is not telling.
const STOP = list(`a about above after again against all also an and any are as at be because been before being below
  between both but by can could did do does doing done down during each few for from had has have having he her here
  hers him his how i if in into is it its just me more most my no nor not now of off on once only or other our ours out
  over own same she should so some such than that the their theirs them then there these they this those through to
  too under until up us very was we were what when where which while who whom whose why will with would you your yours`)
// The last labels of names only an intranet or a home network resolves (with home.arpa).
const INTRANET = list("internal intranet corp lan local localdomain localhost")
// Words that make a label of a public host name internal ("billing.acme-internal.io", "vpn.acme.com").
const INTERNAL = list("internal intranet intra corp private vpn staging preprod uat")
// Labels that name an internal service under an organisation's own domain ("jira.acme.com" beside jane@acme.com).
const SERVICES = list(
  "jira confluence wiki git gitlab jenkins ci build grafana kibana sentry vault sso ldap admin dev qa",
)
// Mail domains that are nobody's organisation.
const MAIL = list(`gmail.com googlemail.com outlook.com hotmail.com live.com yahoo.com icloud.com me.com proton.me
  protonmail.com aol.com gmx.com github.com example.com`)
// Private and link-local IP addresses (and IPv4's shared range).
const PRIVATE_IP =
  /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|f[cd][0-9a-f]*:|fe[89ab][0-9a-f]*:)/
// The private names and addresses everyone writes, which name nobody's network: routers' defaults, cloud metadata,
// Docker's and Kubernetes' own names, the Android emulator's host, minikube, Tailscale's DNS, and home devices' names.
const WELL_KNOWN = list(`192.168.0.1 192.168.1.1 192.168.1.254 10.0.0.1 172.16.0.1 169.254.169.254 10.0.2.2 10.0.2.15
  172.17.0.1 192.168.49.2 10.96.0.1 10.96.0.10 100.100.100.100 fe80::1 host.docker.internal gateway.docker.internal
  kubernetes.docker.internal metadata.google.internal kubernetes.default kubernetes.default.svc
  kubernetes.default.svc.cluster.local raspberrypi.local homeassistant.local`)
const KUBE_SYSTEM = ".kube-system.svc.cluster.local"
// Home folder names that are nobody's user name: placeholders, and the users of CI runners, containers and images.
const GENERIC_USERS = list(`shared public default all guest admin administrator root user username user1 name me you
  yourname yourusername runner runneradmin ubuntu ec2-user vagrant pi node app www-data circleci travis jenkins git
  docker vscode codespace codespaces developer dev test $user %username% linuxbrew jovyan gradle airflow coder gitpod
  seluser pwuser nonroot appuser bun deno rails postgres mysql nginx www vector`)

// What stands between two words.
const WORD = /[^\p{L}\p{N}]+/u
// Locators are found inside runs of the characters they are made of, each cut to MAX_RUN, so the patterns do a bounded
// amount of work at each place and the check stays linear in the size of the private context.
const MAX_RUN = 128
const TOKEN_RUN = /[\w.+\-@:]+/g
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
// Not after a dot, so a file such as .env.local is not a host.
const HOST = /(?<![\w.-])[a-z0-9_-]+(?:\.[a-z0-9_-]+)+/g
const IPV6 = /(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}/g
// A machine's name: letters and a number ("build01", "db-02", "billing07"). Name, mail and web servers are named in
// public DNS ("ns51", "mx01", "www2"), and a year names an edition ("cvpr2023"), not a machine.
const MACHINE = /^(?!(?:ns|mx|www|smtp|mail|imap|pop)-?\d)[a-z]{2,}-?(?!(?:19|20)\d\d$)\d{2,}$/
// A home folder, and the user name in it ("/Users/person/", "/home/kb/", "C:\Users\someone\", "~kb/", where
// the name after a tilde starts with a letter, so "~200/month" names nobody), and a path that starts at a root, a
// drive or home ("/srv/x", "D:\finance", "~/notes").
const HOME = /(?:^|[^\w.-])(?:(?:[a-z]:)?[\\/](?:users|home)[\\/]|~(?=[a-z][\w.-]*[\\/]))([^\\/\s"'`<>|:*?,;()[\]{}]+)/g
const LOCAL = /^(?:[a-z]:|~)?[\\/]/
// A secret worth looking for in a query, once folded: 6 characters or more with no space, letters and digits among
// them ("tr0ub4dor&3x", "correcthorse42"), and no code. A plain word, an identifier and an expression are left out,
// since code gives them to secret-sounding names ("password = hashed", "token = yield* auth", "key = match[0]").
const KEYLIKE = /^(?=[^\s()[\]{}<>=;,\\]{6,}$)(?=.*\p{L})(?=.*\d)/u
// A password written straight after its name ("password correcthorse42"), which BrainScan leaves to prose when its
// digits are one run, and a licence key ("VK7JG-NPHTM-C97JM-9MPGT-3V66T").
const AFTER_PASSWORD = /\b(?:passwords?|passwd|passphrase|passcode|pwd|pw)\b[\s:=,-]{1,3}(?![$%<{])([^\s"'`,;]+)/gi
const LICENCE = /(?<![\w-])[a-z0-9]{5}(?:-[a-z0-9]{5}){4}(?![\w-])/gi
// A hashing scheme given as a password's value ("passwords - argon2id", "password hashing = pbkdf2_sha256",
// "password = bcrypt2b") says how passwords are kept, not what one is. Only a scheme's own spellings count, so a
// password that starts with one ("sha1lover99", "md5_Hunter2024", "bcryptFan2024") is still a password.
const SCHEME =
  /^(?:argon2(?:id|i|d)?|bcrypt(?:2[abxy])?|scrypt|yescrypt|pbkdf2(?:[-_]?(?:with)?[-_]?hmac)?(?:[-_]?sha-?\d+)?|md5(?:crypt)?|(?:hmac[-_]?)?sha-?\d+(?:[-_]\d+)?(?:crypt)?|(?:sha-?\d+|md5|des|bsdi)[-_]?crypt|bcrypt[-_]sha-?\d+|ldap[-_](?:salted[-_])?(?:md5|sha\d*|crypt|bcrypt|pbkdf2[-_]sha\d+)|blake(?:2[bs]?|3))(?:[-_](?:hashed|based))?$/i
// Quotes, brackets and punctuation around a value that are not part of it.
const EDGE = /^["'`\u201c\u2018([{<]+|["'`\u201d\u2019)\]}>,.;:!?]+$/gu
// What a reader reads past: accents and other combining marks once NFKD has split them off, and invisible characters.
const UNSEEN = /[\p{M}\p{Default_Ignorable_Code_Point}]/gu
// A decimal digit of any script. NFKD has made full-width, superscript and mathematical digits ASCII ones already.
const DIGIT = /\p{Nd}/gu

// A number is groups of digits with one usual separator between each two: a space (NFKD makes a no-break or thin space
// one), a hyphen or dash, a dot, a slash, an underscore, or the parentheses around an area code. Commas and apostrophes
// group amounts, which are not contacts, so they separate numbers. A run of years ("2024 2025 2026") is a list, and so
// are two groups of which one is a year and the other is not a group of 3 or 4 digits ("FY2024-25", "ISO 27001 2022",
// "CVE-2024-12345"); a longer run with a year in it stays one number ("123-45-1987", "4417 1999 2001 9113"). Dotted
// groups are a phone number when they read as one (415.555.0177, 1.415.555.0177), a version or an IPv4 address when a
// group has one digit or they read as an address (22.04.4, 130.0.6723.91, 10.0.19045), a decimal or an arXiv ID when
// there are two (2410.12345), and a number otherwise. DOIs and ISBNs are public identifiers. A run of more than
// MAX_GROUPS groups is a list, each group a number of its own. A date with a valid month and day (2025-10-20,
// 2025/10/20, 21/10/2025, 10.21.2025, Dec 12 2025, 20251020) is a number of its own before any of that, so an hour or a
// count after it ("2025-10-20 14:30", "2025-11-03 9 people", "Dec 12 2025 1400") is not one number with it;
// 123-45-1987 and 4417 1999 2001 9113 are no date. Nor is a date-shaped part of a longer number: groups joined to it by
// its own separator ("2019-12-31-0042-7781", "4532-12-10-2019-9113") keep it in the number, and so do groups before a
// compact date ("110105 19491231 002X"), while one written apart from it, as a range is ("2025-10-06/2025-10-17"),
// does not.
const YEAR_FIRST = /(?<!\d)(?=\d{4}([-/.]))(?<!\d\1)(?:19|20)\d\d\1(\d{1,2})\1(\d{1,2})(?!\1?\d)/g
const YEAR_LAST = /(?<!\d)(?=\d{1,2}([-/.]))(?<!\d\1)(\d{1,2})\1(\d{1,2})\1(?:19|20)\d\d(?!\1?\d)/g
const MONTH_NAMED =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:19|20)\d\d(?!\d)/g
const COMPACT_DATE =
  /(?<!\d\)?[\s./_\u2010-\u2015\u2212()-]?)(?:19|20)\d\d(\d\d)(\d\d)(?!\d|[-/._\u2010-\u2015\u2212]\d|\s\d{5})/gu
const DOTTED = /(?<![\d.])\d+(?:\.\d+)+/g
const DOTTED_PHONE = /^(?:1\.)?\d{3}\.\d{3}\.\d{4}$/
const PUBLIC_ID = /\b10\.\d{4,9}\/\S+|\bisbn(?:-1[03])?[\s:]*\d[\d -]{8,16}[\dx]?/gi
const SEPARATOR = /^(?:[ ./_\u2010-\u2015\u2212-]|\)? ?\(?)$/u
const YEAR = /^(?:19|20)\d\d$/
const MAX_GROUPS = 8
// A contact number has this many digits or more, and a query holds one when it shares this many in a row with it. A
// run of more than MAX_DIGITS is data, not a contact. A public text with more than PUBLIC_NUMBERS clears none.
const CONTACT_DIGITS = 9
const MAX_DIGITS = 40
const PUBLIC_NUMBERS = 100
// A working tree's path that is refused whole has this many parts or more, so a container's /usr/src/app goes out.
const MIN_TREE_PARTS = 4

/** Whether a search query may leave, given the run's private context. */
export function check(query: string, context: Context): Result {
  return inspect(query, context, true)
}

/**
 * Whether an address may be read, by the same check on its user name and password, path, query and fragment, and on
 * the part of its host before its site: the site came from provenance, but a name such as
 * jira.initech.internal.attacker.example carries text the way a path does. Its path is read for a home folder and the
 * working tree, not for a user name elsewhere in it (github.com/<name> is a public page).
 */
export function address(url: string, context: Context): Result {
  if (!URL.canParse(url)) return refused("token", url)
  const parsed = new URL(url)
  const path = ResearchCanonical.decoded(parsed.pathname)
  const known = prepare(context)
  const lower = fold(path)
  const local = usersOf(lower).find((name) => known.users.has(name)) ?? known.trees.find((tree) => lower.includes(tree))
  if (local) return refused("token", local)
  const text = [
    subdomainOf(parsed.hostname),
    parsed.username,
    parsed.password,
    ...path.split("/"),
    ...[...parsed.searchParams].flat(),
    parsed.hash.slice(1),
  ]
  return inspect(text.map(ResearchCanonical.decoded).join(" "), context, false)
}

/**
 * The context as browsers apply it in research (research_browser's addresses and typing, and the lead's handoff): a
 * public source of the run clears no number, so a hostile page that lists numbers cannot make one of the user's
 * sendable. Runs of words a public source holds stay clear, as they do for searches.
 */
export function strict(context: Context): Context {
  return { ...context, public: context.public.map((text) => text.replace(/\p{Nd}/gu, " ")) }
}

/** The email addresses, host names and IP addresses in a text, in lower case. */
export function rare(text: string) {
  const lower = fold(text)
  const hosts = locators(lower).filter((host) =>
    isIP(host) ? !["127.0.0.1", "0.0.0.0", "::1", "::"].includes(host) : intranet(host) || publicHost(host),
  )
  return [...new Set([...found(lower, EMAIL), ...hosts])]
}

/** @deprecated The check reads no names, since a name of a person or a company is never refused. It returns none. */
export function names(_texts: readonly string[]): string[] {
  return []
}

// The check. In a search query (`query`) the user's domains may go as host names, and every local path is read for a
// user name; `address` reads its path for a home folder and the working tree itself.
function inspect(text: string, context: Context, query: boolean): Result {
  // A long run of letters and digits alone is as often a checksum or an ID as a key, so it counts only when the private
  // context holds it. A query names models, runners and curves beside "login" or "credentials" far more often than it
  // gives a password, so a word only digits break up is no password there; a symbol among its letters still makes one.
  const reading = { digits: false }
  if (BrainScan.credential(text, reading) || BrainScan.named(text, process.env, reading).redacted)
    return refused("secret", "a password, key or token")
  const known = prepare(context)
  const lower = fold(text)
  if (known.secrets.some((secret) => whole(lower, secret))) return refused("secret", "a password, key or token")
  const words = lower.split(WORD).filter(Boolean)
  const telling = (size: number) =>
    grams(words, size)
      .filter((gram) => gram.some((word) => !common(word)))
      .map((gram) => ` ${gram.join(" ")} `)
  const run = [
    ...telling(RUN_WORDS).filter((gram) => known.facts.includes(gram)),
    ...telling(WORK_RUN_WORDS).filter((gram) => known.work.includes(gram)),
  ].find((gram) => !known.allowed.includes(gram))
  if (run) return refused("words", run.trim())
  const contact =
    known.emails.find((email) => lower.includes(email)) ??
    numbersOf(lower).find((digits) => windows(digits).some((window) => known.numbers.has(window))) ??
    locators(lower)
      .filter((token) => !query || !known.domains.has(token.replace(/^www\./, "")))
      .flatMap((token) => known.hosts.filter((host) => holds(token, host)))[0] ??
    [...usersOf(lower), ...(query ? segmentsOf(lower) : [])].find((name) => known.users.has(name)) ??
    known.trees.find((tree) => lower.includes(tree))
  if (contact) return refused("token", contact)
  return { ok: true }
}

function refused(reason: Reason, match: string): Result {
  return { ok: false, reason, match, message: REFUSAL }
}

// The context as the check reads it, worked out once per context object.
const PREPARED = new WeakMap<Context, ReturnType<typeof build>>()

function prepare(context: Context) {
  const known = PREPARED.get(context) ?? build(context)
  PREPARED.set(context, known)
  return known
}

function build(context: Context) {
  const facts = context.private.map(fold)
  const work = (context.work ?? []).map(fold)
  const all = [...facts, ...work]
  const typed = context.typed.map(fold)
  const shown = context.public.map(fold)
  const typedNumbers = typed.flatMap(numbersOf)
  const shownNumbers = shown.map(numbersOf).flatMap((numbers) => (numbers.length > PUBLIC_NUMBERS ? [] : numbers))
  // An organisation's own domain is one a private fact has an email address at: a repository's files name the
  // addresses of projects and maintainers too ("bugs to bug-foo@gnu.org").
  const orgs = new Set(
    facts
      .flatMap((text) => found(text, EMAIL))
      .map((email) => parse(email.slice(email.indexOf("@") + 1), { allowPrivateDomains: true }).domain ?? "")
      .filter((domain) => domain && !MAIL.has(domain)),
  )
  const typedHosts = typed.flatMap(locators)
  const listed = new Set(
    (context.results ?? []).flatMap((url) => (URL.canParse(url) ? [fold(new URL(url).hostname)] : [])),
  )
  const typedUsers = new Set(typed.flatMap((text) => [...usersOf(text), ...segmentsOf(text)]))
  return {
    secrets: [
      ...new Set(
        [
          ...context.private.flatMap((text) => secretsOf(text, true)),
          ...(context.work ?? []).flatMap((text) => secretsOf(text, false)),
        ]
          .filter((found) => !found.weak || ![...typed, ...shown].some((text) => whole(text, found.value)))
          .map((found) => found.value),
      ),
    ],
    facts: joined(facts),
    work: joined(work),
    allowed: joined([...typed, ...shown]),
    emails: [...new Set(facts.flatMap((text) => found(text, EMAIL)))].filter(
      (email) => ![...typed, ...shown].some((text) => text.includes(email)),
    ),
    // Every run of CONTACT_DIGITS digits of the contact numbers that no public source holds and the user did not type:
    // typing clears a number it holds whole or that holds it whole, not one that shares some digits with it.
    numbers: new Set(
      [...new Set(facts.flatMap(numbersOf))]
        .filter((digits) => digits.length <= MAX_DIGITS && !shownNumbers.some((item) => item.includes(digits)))
        .filter((digits) => !typedNumbers.some((item) => item.includes(digits) || digits.includes(item)))
        .flatMap(windows),
    ),
    hosts: [...new Set(all.flatMap(locators))].filter(
      (host) =>
        internal(host, orgs) &&
        !typedHosts.some((token) => holds(token, host)) &&
        (isIP(host) || intranet(host) || !listed.has(host)),
    ),
    trees: (context.home ?? [])
      .map((tree) => fold(tree).replace(/[\\/]+$/, ""))
      .filter((tree) => tree.split(/[\\/]+/).filter(Boolean).length >= MIN_TREE_PARTS)
      .filter((tree) => !typed.some((text) => text.includes(tree))),
    users: new Set(
      [...facts, ...(context.home ?? []).map(fold)]
        .flatMap(usersOf)
        .filter((name) => name.length >= 2 && !GENERIC_USERS.has(name) && !typedUsers.has(name)),
    ),
    domains: new Set(
      (context.domains ?? [])
        .map((domain) => fold(domain).replace(/^\s*(?:\*?\.|www\.)?|\.?\s*$/g, ""))
        .filter(publicHost),
    ),
  }
}

// Whether a host name or an IP address from the private context is private (rule 4). A site's own label counts only
// as a part ("acme-internal"), so a file such as internal.md is not one.
function internal(host: string, orgs: ReadonlySet<string>) {
  if (WELL_KNOWN.has(host) || host.endsWith(KUBE_SYSTEM)) return false
  // A network's or a broadcast address names no machine.
  if (isIP(host)) return PRIVATE_IP.test(host) && !/\.(?:0|255)$/.test(host)
  if (intranet(host)) return true
  const parsed = parse(host, { allowPrivateDomains: true })
  if (!parsed.domain || (!parsed.isIcann && !parsed.isPrivate)) return false
  const site = parsed.domainWithoutSuffix ?? ""
  const worded = (label: string) => label.split("-").some((piece) => INTERNAL.has(piece))
  return (
    (site.includes("-") && worded(site)) ||
    (parsed.subdomain ?? "")
      .split(".")
      .some((label) => worded(label) || MACHINE.test(label) || (orgs.has(parsed.domain!) && SERVICES.has(label)))
  )
}

// A name on an intranet's or a home network's suffix (jira.acme.internal, nas.home.arpa, api.acme.localhost).
function intranet(host: string) {
  return INTRANET.has(host.slice(host.lastIndexOf(".") + 1)) || host.endsWith(".home.arpa")
}

function publicHost(host: string) {
  const parsed = parse(host, { allowPrivateDomains: true })
  return parsed.hostname === host && !!parsed.domain && (!!parsed.isIcann || !!parsed.isPrivate)
}

// Whether a host-like token holds a private host or IP address whole, label for label: jira.acme.internal is in
// jira.acme.internal.attacker.example, and not in xjira.acme.internal.
function holds(token: string, host: string) {
  return `.${token}.`.includes(`.${host}.`)
}

// The secrets of a private text as a query may copy them, folded (rule 1): each value BrainScan finds, whole, and each
// licence key, with whether only the weakest sign gave it away (BrainScan.Found). BrainScan gives the password of an
// address or a login pair, not the user name and host around it ("Tr0ub4dor&3x" of "admin / Tr0ub4dor&3x"), and a
// private key line by line. The private facts are prose, so the words around a value may
// give it away there ("the wifi password is correcthorse42", "password correcthorse42"), and a passphrase of 3 or more
// words counts. The work is code, documentation and command output, which name algorithms, models and machines beside
// the word "password" or "credentials" far more often than they give one, so only a value that its shape, an
// assignment, an address, a login pair or "the password is X" gives away counts there, and a phrase given to a
// secret-sounding name is as often an interface's copy ("Enter your password").
function secretsOf(text: string, facts: boolean) {
  return [
    ...BrainScan.secrets(text, {}, { code: !facts }),
    ...(text.match(LICENCE) ?? []).map((value) => ({ value, weak: false })),
    ...(facts ? [...text.matchAll(AFTER_PASSWORD)].map((match) => ({ value: match[1]!, weak: false })) : []),
  ]
    .flatMap((found) => {
      const value = fold(found.value)
      return [value, value.replace(EDGE, "")].map((each) => ({ value: each, weak: found.weak }))
    })
    .filter((found) => !SCHEME.test(found.value.replace(EDGE, "")))
    .filter(
      (found) =>
        KEYLIKE.test(found.value) || (facts && found.value.length >= 6 && found.value.split(/\s+/).length >= 3),
    )
}

// Whether a folded text holds a value whole, not inside a longer word or number.
function whole(lower: string, value: string): boolean {
  const at = lower.indexOf(value)
  if (at < 0) return false
  const edge = (char: string | undefined) => !char || !/[\p{L}\p{N}]/u.test(char)
  return (edge(lower[at - 1]) && edge(lower[at + value.length])) || whole(lower.slice(at + 1), value)
}

// The contact-length numbers of a folded text as strings of digits, read as the comment on DOTTED says.
function numbersOf(text: string) {
  const plain = text
    .replace(YEAR_FIRST, (date, _, month: string, day: string) => (calendar(month, day) ? " ; " : date))
    .replace(YEAR_LAST, (date, _, first: string, second: string) =>
      calendar(first, second) || calendar(second, first) ? " ; " : date,
    )
    .replace(MONTH_NAMED, (date, day: string) => (calendar("1", day) ? " ; " : date))
    .replace(COMPACT_DATE, (date, month: string, day: string) => (calendar(month, day) ? " ; " : date))
    .replace(PUBLIC_ID, " ; ")
    .replace(DOTTED, (run) => {
      if (DOTTED_PHONE.test(run)) return run
      const groups = run.split(".")
      if (isIP(run) === 4 || groups.some((group) => group.length === 1)) return " ; "
      return groups.length === 2 ? groups.join(" ; ") : run
    })
  return [...plain.matchAll(/\d+/g)]
    .reduce<{ groups: string[]; end: number }[]>((runs, match) => {
      const last = runs.at(-1)
      const end = match.index + match[0].length
      if (last && SEPARATOR.test(plain.slice(last.end, match.index))) {
        last.groups.push(match[0])
        last.end = end
        return runs
      }
      runs.push({ groups: [match[0]], end })
      return runs
    }, [])
    .flatMap((run) => (apart(run.groups) ? run.groups : [run.groups.join("")]))
    .filter((digits) => digits.length >= CONTACT_DIGITS)
}

// Whether two groups of digits are a month and a day in it.
function calendar(month: string, day: string) {
  return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= 31
}

// Whether a run of groups of digits is a list of numbers rather than one (see the comment on DOTTED).
function apart(groups: readonly string[]) {
  if (groups.length > MAX_GROUPS || groups.every((group) => YEAR.test(group))) return true
  return (
    groups.length === 2 &&
    groups.some((group) => YEAR.test(group)) &&
    !groups.every((group) => YEAR.test(group) || /^\d{3,4}$/.test(group))
  )
}

// Every run of CONTACT_DIGITS digits in a string of digits.
function windows(digits: string) {
  return Array.from({ length: Math.max(0, digits.length - CONTACT_DIGITS + 1) }, (_, index) =>
    digits.slice(index, index + CONTACT_DIGITS),
  )
}

// What a pattern finds in the runs of a folded text, each run cut to MAX_RUN.
function found(lower: string, pattern: RegExp) {
  return (lower.match(TOKEN_RUN) ?? []).flatMap((run) =>
    Array.from({ length: Math.ceil(run.length / MAX_RUN) }, (_, index) =>
      run.slice(index * MAX_RUN, (index + 1) * MAX_RUN),
    ).flatMap((chunk) => chunk.match(pattern) ?? []),
  )
}

// The host names, IPv4 addresses and IPv6 addresses of a folded text.
function locators(lower: string) {
  return [...found(lower, HOST), ...found(lower, IPV6).filter((ip) => isIP(ip) === 6)]
}

function usersOf(lower: string) {
  return [...lower.matchAll(HOME)].map((match) => match[1]!.replace(/\.+$/, ""))
}

// The parts of the local paths in a text, which hold a user name as often as a home folder does ("D:\kb\ledger.db").
function segmentsOf(lower: string) {
  return lower
    .split(/[\s"'`<>|()[\]{},;]+/)
    .filter((token) => LOCAL.test(token))
    .flatMap((token) => token.split(/[\\/]+/).map((part) => part.replace(/\.+$/, "")))
}

// The part of a host before its site, each label's punycode decoded. When tldts finds no site, as in a host with a
// label it rejects (an underscore, a dash at either end, punycode that does not decode), the whole host is read.
function subdomainOf(hostname: string) {
  const name = hostname.replace(/\.$/, "")
  if (isIP(name.replace(/^\[|\]$/g, ""))) return ""
  const parsed = parse(name, { allowPrivateDomains: true })
  return (parsed.domain ? (parsed.subdomain ?? "") : name)
    .split(".")
    .map((label) => (label.startsWith("xn--") ? domainToUnicode(label) || label : label))
    .join(".")
}

// Text as the check compares it (see the comment at the top), in lower case.
function fold(text: string) {
  return WebFence.latin(text.normalize("NFKD").replace(UNSEEN, "").replace(DIGIT, ascii)).toLowerCase()
}

// A decimal digit of any script as its ASCII digit. Unicode gives each script's digits 0 to 9 in order, in blocks of
// ten that may follow one another, so a digit's value is the count of digits straight before it, modulo ten.
function ascii(digit: string) {
  const code = digit.codePointAt(0)!
  if (code < 0x80) return digit
  const before = Array.from({ length: 60 }, (_, index) => code - index - 1).findIndex(
    (at) => !/^\p{Nd}$/u.test(String.fromCodePoint(at)),
  )
  return String(before % 10)
}

// A word that says nothing on its own: a function word, a common English word, or a number of up to 4 digits.
function common(word: string) {
  return STOP.has(word) || ResearchWords.common(word) || /^\d{1,4}$/.test(word)
}

function grams(words: readonly string[], size: number) {
  return words.slice(0, Math.max(0, words.length - size + 1)).map((_, index) => words.slice(index, index + size))
}

function joined(texts: readonly string[]) {
  return ` ${texts.map((text) => text.split(WORD).filter(Boolean).join(" ")).join(" \n ")} `
}
