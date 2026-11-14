export * as BrainScan from "./scan"

import { collectSecretValues, redactSecrets, REDACTED } from "../review/redact"

// Checks every memory write, and every line mirrored from a file, before it can reach a prompt. All of it is plain
// pattern matching: no model reads a memory to decide whether it is safe.

// Zero-width characters, bidirectional controls and Unicode tag characters. They render as nothing, so a rules file can
// carry text a person reviewing it never sees (the "rules file backdoor").
const HIDDEN = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]|[\u{E0000}-\u{E007F}]/gu

export function hidden(text: string) {
  return text.search(HIDDEN) >= 0
}

export function stripHidden(text: string) {
  return text.replace(HIDDEN, "")
}

// `password = hunter2`, `DATABASE_PASSWORD='correct horse battery staple'`, `"token": "…"`: a value given to a
// secret-sounding name. Group 1 is a quote around the name, 2 the name, 3 `:` or `=`, 4 the value. The name's prefix is
// bounded, so a long run of name characters costs a fixed amount at each place a match is tried, not the rest of it.
const ASSIGNED =
  /(["']?)\b([\w.-]{0,128}?(?:password|passwd|passphrase|passcode|pass|pwd|secret|secret[_-]?key|token|api[_-]?key|access[_-]?key|private[_-]?key))\1\s*([:=])\s*("[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/gi

// What stands where a secret would in code and configuration: an environment variable, a template slot (closed or not:
// "?auth_token=<base64 guest:secret>" ends the value at its first space), a type, a mask. None of them is the secret.
const PLACEHOLDER =
  /^(?:\$.*|<[^<>]*>?|\{\{.*|process\.env\b.*|env\.\w+|os\.(?:environ|getenv)\b.*|\*+|x{3,}|\.{3,}|string|number|boolean|bool|str|int|any|unknown|null|undefined|none|nil|true|false|optional|required|\[redacted\]|redacted)$/i

// What a found value is replaced with. `secrets` passes one that also notes the value down.
type Hide = (value: string) => string
const conceal: Hide = () => REDACTED

// A value given to a secret-sounding name is the secret, whatever it looks like, when it is code or configuration
// (`=`, a quoted or identifier-like name, a quoted value) or when the name is a password. In prose ("the token:
// validate it before use") only a value that looks like a key is.
function assigned(text: string, hide = conceal) {
  return text.replace(ASSIGNED, (match, quote: string, name: string, separator: string, value: string) => {
    // "bypass" and "compass" end in "pass" without naming one.
    if (
      /(?:pass|pwd)$/i.test(name) &&
      !/(?:^|[_.-])(?:pass|pwd)$/i.test(name) &&
      !/pass(?:word|wd|phrase|code)$/i.test(name)
    )
      return match
    const bare = value.replace(/^["']|["']$/g, "").trim()
    // A type in a signature or schema ("token: String!)", "password: string;") names no value.
    if (!bare || PLACEHOLDER.test(bare) || PLACEHOLDER.test(bare.replace(/^\[+|[!?)\]}:,.]+$/g, ""))) return match
    const code = separator === "=" || quote !== "" || value !== bare || /[_.-]|[A-Z]/.test(name)
    const password = /(?:pass(?:word|wd|phrase|code)?|pwd)$/i.test(name)
    if (!code && !password && !(bare.length >= 8 && /[\d$#@!%^&*]/.test(bare))) return match
    if (!code && password && NOT_A_VALUE.test(bare.replace(/[.!?]+$/, ""))) return match
    return `${match.slice(0, match.length - value.length)}${hide(value)}`
  })
}

// A private key: its header with its body straight after it, up to its END line or the first line that is not base64,
// so a key cut short ("MIIEpAIB...") ends with its last whole line, not at the end of the text. "Name: value" lines may
// follow the header, a line may break written or escaped ("\n"), and a line may sit between the marks code, a quote or
// a comment writes it with (quotes, "+", ">", "#", "*"). A key on one line is the rest of its header's line. A header
// named in prose ("it starts with -----BEGIN OPENSSH PRIVATE KEY-----, then") has no body, so it is no key.
// A "+" is a mark only before a space, as it joins the lines of a string in code: in a line it is base64.
const KEY_MARKS = String.raw`(?:[^\S\n]|["'>#*,;]|\+(?=\s))*`
const KEY_BREAK = String.raw`(?:(?:\\[rn])+(?:${KEY_MARKS}\n)?|\n)`
const KEY_START = String.raw`(?:\s|\\[rn]|["'>#*,;]|\+(?=\s))*(?:[\w-]+: [^\n]*\n\s*)*`
const KEY_BODY_LINE = String.raw`[A-Za-z0-9+/]+={0,2}${KEY_MARKS}(?=\n|\\[rn]|-----|$)`
const KEY_END = "-----END [A-Z ]*PRIVATE KEY-----"
const PRIVATE_KEY = new RegExp(
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----(?=${KEY_START}[A-Za-z0-9+/]{16})` +
    String.raw`(?:[^\S\n]+(?=[A-Za-z0-9+/])[^\n]*?(?:${KEY_END}|(?=\n|$))` +
    // The marks before a line are taken whole, `(?=(…))\1` standing for an atomic group, so a long run of them is read
    // once rather than again at each place a line could start.
    String.raw`|(?=(${KEY_START}))\1${KEY_BODY_LINE}(?:${KEY_BREAK}(?=(${KEY_MARKS}))\2${KEY_BODY_LINE})*(?:${KEY_BREAK}?${KEY_MARKS}${KEY_END})?)?`,
  "g",
)
// A line of a key's body, which `secrets` gives one at a time: a key is quoted a line at a time as often as whole.
const KEY_LINE = /(?<=[\s"'>#*,;]|\\[rn]|-----)[A-Za-z0-9+/]{16,}={0,2}(?=[\s"',;]|\\[rn]|-----|$)/g
// The last line of a key's body, right before its END line, however short: read for shapes (see `Reading`), it is
// replaced too. It has a letter or a digit, so the "+" that joins a key's lines in code is none. The marks after it are
// taken whole, as PRIVATE_KEY takes them, so a long run of them is read once.
const KEY_LAST = new RegExp(
  String.raw`(?<=[\s"'>#*,;]|\\[rn]|-----)(?=[A-Za-z0-9+/]*[A-Za-z0-9])[A-Za-z0-9+/]+={0,2}` +
    String.raw`(?=(?=(${KEY_MARKS}))\1(?:${KEY_BREAK})?(?=(${KEY_MARKS}))\2${KEY_END})`,
  "g",
)

// An address with a user name and a password ("postgres://app:S3cretPassw0rd@db"), unless the password stands for one
// ("https://oauth2:${GITLAB_TOKEN}@gitlab.com"). Group 1 is what comes before the password, 2 the password, 3 the rest.
const CREDENTIALED = /\b([A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s:/@]+:)([^\s/@]+)(@\S+)/g
const STANDS_FOR = /^(?:\$\{[^{}]+\}|\$[A-Z_][A-Z0-9_]*|<[^<>]+>|%\w+%|\{\{[^{}]+\}\})$/

// Shapes that are a credential wherever they appear, beyond the provider token shapes review redaction knows.
const SECRET_SHAPES = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  /\bvct_[A-Za-z0-9._-]{16,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g,
  // Incoming webhooks: the URL is the credential.
  /\bhttps?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]+/gi,
  /\bhttps?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/gi,
  /\bhttps?:\/\/[\w.-]+\.webhook\.office\.com\/[^\s"'<>]+/gi,
]

// A secret written in plain words: "the admin password is Tr0ub4dor&3x", "the wifi passphrase is correct horse battery
// staple", "the admin password for staging is Tr0ub4dor&3x", "the wifi code for the office is 8842-1937-2210". A few
// words of what it is for may sit between the name and "is". A phrase runs to the end of its clause; any other secret is
// the one word after "is".
const SPOKEN =
  /\b(password|passwd|passcode|passphrase|pin(?: code)?|secret|token|api key|access key|(?:unlock|recovery|seed|pass) (?:phrase|code|key|words)|(?:wi-?fi|door|alarm|gate|safe|entry|access) (?:code|password|key)|pass)(?:\s+(?:for|of|on|to|at)\s+(?:(?:the|a|an|our|my|your)\s+)?[\w'-]+(?:\s+[\w'-]+){0,2}?)?\s+(?:is|was|are|were)\s+["'“]?([^\s"'”,;]+(?:\s+[^\s"'”,;.]+)*)/gi

// Words after "the password is" that say something about it rather than give it: "is stored in 1Password", "is
// required", "is the same as staging".
const NOT_A_VALUE =
  /^(?:stored|kept|saved|managed|set|read|loaded|in|on|at|from|the|a|an|not|never|no|required|needed|optional|rotated|generated|available|provided|configured|defined|found|written|shared|sent|changed|hashed|encrypted|missing|empty|wrong|valid|invalid|incorrect|accepted|rejected|allowed|denied|enabled|disabled|active|inactive|expired|only|always|usually|also|still|now|then|same|different|unknown|too|of|for|to|under|via|by|injected|passed|fetched|pulled|created|reset|entered|typed|asked|prompted|validated|checked|verified|used|mandatory|long|short|strong|weak|secure|insecure|private|public|secret|random|unique|complex|simple|easy|hard|good|bad|fine|ok|okay|old|new|current|default|temporary|temp|personal|common|known|obvious|visible|hidden|plain|plaintext|cleartext|masked|blank|null|none|nothing|something|here|there|below|above|this|that|it|what|which|whatever|see|ask|check|case|its|their|your|my|our|his|her|\[redacted\])$/i

// Words that describe a password rather than give it: "is case-sensitive", "is rotating", "is configurable".
const DESCRIBES = /(?:ed|able|ible|ive|ly|ing|ful|less|ous)$/i

// One word passes for a password when it is not plain prose: it has a digit, a symbol or a capital inside it. A phrase
// ("correct horse battery staple") is all words, so a passphrase or recovery phrase is taken whole.
const PASSWORD_LIKE = /\d|[!@#$%^&*_+=~?<>|\\]|[a-z][A-Z]/

// A username and password pair: "login: admin / hunter2hunter2", "credentials are deploy/s3cret!", "basic auth is
// admin:Tr0ub4dor&3x". The password has a letter and a digit or symbol, so "localhost:3000" is not one. An endpoint is
// not a pair: an HTTP method is not a username, and after a spaced "/" a path ("Login: POST /v1/session") is not a
// password. Nor is an AWS credential scope ("Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request"): an
// access key ID is no username, and a password has no more than one "/". Group 1 is the name, 2 the password.
const LOGIN =
  /\b((?:login|logins|credentials?|creds|basic auth)\s*(?::|=|\bis\b|\bare\b))\s*["']?(?!(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\b)(?!(?:AKIA|ASIA)[0-9A-Z]{16}\/)[^\s"'/:]+(?:\s*:\s*|\/|\s+\/\s*(?![^\s"',;]*\/)|\/\s+(?![^\s"',;]*\/))(?!\/)(?![^\s"',;]*\/[^\s"',;]*\/)(?=[^\s"',;]*[A-Za-z])(?=[^\s"',;]*[\d!@#$%^&*_+=~?])([^\s"',;]+)/gi

// Words that name a password, a login or a code. A password-like value in the same sentence is that secret, wherever it
// sits: "the staging admin's password, Tr0ub4dor&3x, is in the seed script", "log in to staging as admin with
// Tr0ub4dor&3x", "use hunter2hunter2 as the admin password". A PIN or a door code is digits.
const SECRET_NEAR =
  /\b(?:passwords?|passwd|pw|passphrases?|passcodes?|credentials?|creds|basic auth|log ?ins?|logon|sign ?ins?|(?:wi-?fi|door|alarm|gate|safe|entry|access) (?:codes?|passwords?|keys?)|pins?(?: codes?)?)\b/gi

// A sentence: up to a full stop, question mark, exclamation mark or semicolon that ends it, or a line break. A dot inside
// a word ("utils.ts") does not end one.
const SENTENCE = /(?:[^\n.!?;]|[.!?;](?![\s]|$))+/g

// Punctuation and markup around a word that is not part of it: "**Login**:", "(Tr0ub4dor&3x),".
const EDGE = /^[*_`"'“”‘’([{<,.;:!?]+|[*_`"'“”‘’)\]}>,.;:!?]+$/g

// Quoted words given as a password: "use 'blue velvet sky' as the wifi password". Quoted text that names a password
// itself ("Show 'Forgot your password?' as the link") is the interface's copy, not a secret.
const AS_PASSWORD =
  /(["'“‘])((?:(?!password|passphrase|log ?in|sign ?in)[^"'”’\n]){4,80})["'”’](?=\s+(?:as|for)\s+(?:(?:the|our|my|your|a)\s+)?(?:[\w'-]+\s+){0,3}(?:password|passphrase|passcode|pin|pw)\b)/gi

// An AWS secret access key is 40 characters that read like a path once split at "/", so beside an access key id any
// such run is the secret.
const AWS_ID = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/
const AWS_IDS = new RegExp(AWS_ID.source, "g")
const AWS_SECRET = /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g

// Read as code (see `Reading`), only a password's value counts: "the staging admin password is Tr0ub4dor&3x".
function spoken(text: string, hide = conceal, asCode = false) {
  return text.replace(SPOKEN, (match, name: string, value: string) => {
    const first = value.split(/\s+/)[0]!.replace(/[.!?]+$/, "")
    if (NOT_A_VALUE.test(first) || /^\$|^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(first)) return match
    const phrase = /phrase|words/i.test(name)
    const password = /pass(?:word|wd|code)?$/i.test(name)
    if (asCode && !password) return match
    // A password is a password in any word ("the staging password is swordfish"). A PIN or a door code is digits ("the
    // version pin is 5.6.2" is not one); another secret is one when it looks like a key.
    const code = /^pin|code$/i.test(name)
    const secret =
      phrase ||
      (password && first.length >= 4 && !DESCRIBES.test(first)) ||
      (!password && code && /^(?:\d{4,8}|\d{2,5}(?:-\d{2,5})+)$/.test(first)) ||
      (!password && !code && first.length >= 6 && PASSWORD_LIKE.test(first))
    if (!secret) return match
    const hidden = phrase ? value.replace(/[.!?]+$/, "") : first
    const at = match.length - value.length
    return `${match.slice(0, at)}${hide(hidden)}${match.slice(at + hidden.length)}`
  })
}

// A PIN or a code beside its name: four to six digits, or groups of digits ("8842-1937-2210").
const DIGITS = /^(?:\d{4,6}|\d{2,5}(?:-\d{2,5})+)$/

// `loose` hides a word that only digits breaking up its letters make password-like ("hunter2hunter2"), and when it is
// false such a word is none.
function near(text: string, hide = conceal, loose: Hide | false = hide) {
  return text.replace(SENTENCE, (sentence) => {
    const named = sentence.match(SECRET_NEAR) ?? []
    if (named.length === 0) return sentence
    const coded = named.some((word) => /pin|code/i.test(word))
    const worded = named.some((word) => !/^pins?(?: codes?)?$/i.test(word))
    return sentence.replace(/\S+/g, (word) => {
      const token = word.replace(EDGE, "")
      if ((worded && passwordLike(token, false)) || (coded && DIGITS.test(token)))
        return word.replace(token, hide(token))
      return loose && worded && passwordLike(token) ? word.replace(token, loose(token)) : word
    })
  })
}

// A word that reads like a password rather than a name, a path or a number: a symbol among letters or digits
// ("Tr0ub4dor&3x", "P@ssw0rd"), or, with `digits`, letters broken up by digits more than once ("hunter2hunter2",
// "s3cr3tpass"). A hashing scheme ("argon2id", "sha256"), a path, a version, a flag, a package scope, an environment
// variable, a commit and an assignment are not.
function passwordLike(token: string, digits = true) {
  if (token.length < 6 || /^[@#$-]|[/.=()[\]{}<>`]/.test(token) || /^[A-Z][A-Z0-9_]*$/.test(token)) return false
  if (/^[0-9a-f]{7,64}$/i.test(token)) return false
  if (/[!@#$%^&*+~?|\\]/.test(token) && /[A-Za-z0-9]/.test(token)) return true
  return digits && token.length >= 8 && /[A-Za-z]/.test(token) && (token.match(/\d+/g)?.length ?? 0) >= 2
}

/**
 * How `credential`, `named` and `secrets` read a text. `code` reads it as code, documentation or command output, which
 * name algorithms, models and machines beside "password" or "credentials" far more often than they give one: of the
 * rules that read the words around a value, only "the password is X" applies. Without `digits`, a word whose letters
 * digits break up more than once is no password beside a login word ("login fails on macos-14-arm64", "sign in with
 * secp256k1", "credentials for gpt-4o-2024-08-06"), and a symbol among letters or digits still makes one.
 *
 * `shapes` reads only what a value's own shape gives away: a private key's body, an address's password, the provider
 * token shapes (review redaction's and SECRET_SHAPES), the environment's secret values, and an AWS key ID and the secret
 * beside it. None of the rules that read the names or words around a value applies (assigned, spoken, login pairs,
 * near, as-password, hex beside a secret word), nor the long mixed runs `redact` takes for keys. Only the value is
 * replaced, a line at a time, so the text around it stays as it was and keeps its lines: a key keeps its marks, an
 * address its user name and host, and an environment value of several lines its line breaks. Every line of a key's
 * body is replaced, its short last line too, and a bare ASIA key ID is. A 40-character run of hex is no AWS secret,
 * and "Bearer" or "Basic" with a word on the next line is no token. `named` and `secrets` honour it and `credential`
 * ignores it. The review payload holdback (VS-34, review/holdback.ts) reads code this way.
 */
export type Reading = { readonly code?: boolean; readonly digits?: boolean; readonly shapes?: boolean }

/**
 * A value `secrets` found, and whether only the weakest sign gave it away (`weak`): a word whose letters digits break up
 * more than once, in a sentence about credentials ("claude-3-5-sonnet-20241022" of "login with
 * claude-3-5-sonnet-20241022").
 */
export type Found = { readonly value: string; readonly weak: boolean }

/**
 * Whether the text gives a password, passphrase, PIN or login together with its value. The agent never saves such a
 * line, even redacted: a secret is not something to remember, and where it lives is what a memory should say.
 */
export function credential(text: string, reading: Reading = {}) {
  const clean = stripHidden(text)
  return (
    spoken(clean, conceal, reading.code) !== clean ||
    clean.search(LOGIN) >= 0 ||
    assigned(clean) !== clean ||
    (!reading.code && near(clean, conceal, reading.digits !== false && conceal) !== clean) ||
    (!reading.code && clean.search(AS_PASSWORD) >= 0)
  )
}

// A long run of mixed letters and digits with no word in it is a key far more often than it is prose or a path. A path
// or identifier ("migration/20261015_add_review_helpers") is made of words, so two word segments rule a match out.
// Whether a run has a digit and a letter is checked once it is matched, so each run is read once.
const OPAQUE = /\b[A-Za-z0-9_\-+/]{32,}={0,2}/g

// A run of hex is a commit or a checksum more often than a key, unless a secret-sounding word is right beside it.
const HEX = /\b[0-9a-f]{32,}\b/gi
const SECRET_WORD = /(?:^|[^a-z])(?:keys?|secrets?|tokens?|passw\w*|credentials?)(?:[^a-z]|$)/i

function keyed(text: string, hide = conceal) {
  return text.replace(HEX, (match: string, offset: number) =>
    SECRET_WORD.test(text.slice(Math.max(0, offset - 40), offset)) ||
    SECRET_WORD.test(text.slice(offset + match.length, offset + match.length + 25))
      ? hide(match)
      : match,
  )
}

function opaque(match: string) {
  if (!/\d/.test(match) || !/[A-Za-z]/.test(match) || /^[0-9a-f]{40}$/i.test(match)) return false
  if (match.split(/[/_\-.+]+/).filter((segment) => /^[a-z]{4,}$/i.test(segment)).length >= 2) return false
  return entropy(match) >= 3.5
}

/** The text with every credential replaced by [redacted], and whether anything was. */
export function redact(text: string, env: Record<string, string | undefined> = process.env) {
  const out = named(text, env).text.replace(OPAQUE, (match) => (opaque(match) ? REDACTED : match))
  return { text: out, redacted: out !== text }
}

/**
 * `redact` without the long runs of mixed letters and digits it takes for keys by their look alone, which are as often
 * a checksum, an ID or an address: only the credentials that their shape, their name or a word beside them gives away.
 */
export function named(text: string, env: Record<string, string | undefined> = process.env, reading: Reading = {}) {
  const out = scrub(text, env, reading)
  return { text: out, redacted: out !== text }
}

/**
 * The values `redact` replaces in a text, as the text writes them. Of an address with a password and of a login pair it
 * gives the password, not the user name and host around it, and of a private key each line of its body. Each notes
 * whether only the weakest sign gave it away (`Found`), which a reader may weigh less than a value its shape, its name,
 * a symbol among its letters or an explicit "the password is" gives.
 */
export function secrets(
  text: string,
  env: Record<string, string | undefined> = process.env,
  reading: Reading = {},
): Found[] {
  const found: Found[] = []
  const out = scrub(text, env, reading, found)
  if (!reading.shapes) found.push(...(out.match(OPAQUE) ?? []).filter(opaque).map((value) => ({ value, weak: false })))
  return found.filter((item) => item.value && !item.value.includes(REDACTED))
}

// `named`'s work. Given `found`, it notes each value down, and only the secret part of an address, a login pair and a
// private key. A value's shape, the environment's values and an AWS secret beside its key ID are read before the words
// around a value are, so that a token or a key in a sentence about credentials is noted as what it is. Read for shapes,
// it replaces only that secret part whether or not it notes it, and reads no further than the AWS key IDs.
function scrub(text: string, env: Record<string, string | undefined>, reading: Reading = {}, found?: Found[]) {
  const note = (weak: boolean) => (value: string) => {
    found?.push({ value: value.trim(), weak })
    return REDACTED
  }
  const hide = reading.shapes ? byLine(note(false)) : note(false)
  const keys = text.replace(PRIVATE_KEY, (block) => {
    if (reading.shapes) return block.replace(KEY_LINE, hide).replace(KEY_LAST, hide)
    return found ? block.replace(KEY_LINE, hide) : hide(block)
  })
  const addresses = keys.replace(CREDENTIALED, (match, head: string, password: string, rest: string) => {
    if (STANDS_FOR.test(password)) return match
    return found || reading.shapes ? `${head}${hide(password)}${rest}` : hide(match)
  })
  // Read for shapes, a shape that runs over a line break gives no value away: only "Bearer" and "Basic" can, and a
  // token sits on their line ("// Basic" above a long name is none).
  const shaped = redactSecrets(
    SECRET_SHAPES.reduce(
      (out, shape) => out.replace(shape, (match) => (reading.shapes && match.includes("\n") ? match : hide(match))),
      addresses,
    ),
    collectSecretValues(env),
    hide,
  )
  // Read for shapes, a run of hex beside a key ID is a commit or a checksum, as `opaque` takes it.
  const aws = AWS_ID.test(text)
    ? shaped.replace(AWS_SECRET, (match) => (reading.shapes && /^[0-9a-f]{40}$/i.test(match) ? match : hide(match)))
    : shaped
  if (reading.shapes) return aws.replace(AWS_IDS, hide)
  const paired = spoken(assigned(aws, hide), hide, reading.code).replace(
    LOGIN,
    (match, name: string, password: string) =>
      found ? `${match.slice(0, match.length - password.length)}${hide(password)}` : `${name} ${hide(match)}`,
  )
  const worded = reading.code
    ? paired
    : near(paired, hide, reading.digits !== false && note(true)).replace(
        AS_PASSWORD,
        (_, quote: string, words: string) => `${quote}${hide(words)}${quote}`,
      )
  return keyed(worded, hide)
}

// A value that runs over a line break (an environment value of several lines, such as a key) is replaced a line at a
// time, and the spaces around each line are kept. Within a line a lone "\r", U+2028 or U+2029 is replaced with the
// rest, which `.` would stop at.
function byLine(hide: Hide): Hide {
  return (value) => value.replace(/[^\n]+/g, (line) => line.replace(/\S(?:[^\n]*\S)?/, hide))
}

/** How much of the text is left once secrets are removed, so an entry that is mostly a secret is refused, not kept. */
export function remainder(text: string) {
  return text.replaceAll(REDACTED, "").replace(/[^A-Za-z0-9]+/g, "").length
}

function entropy(value: string) {
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  return [...counts.values()].reduce((sum, count) => {
    const p = count / value.length
    return sum - p * Math.log2(p)
  }, 0)
}

// Text written to steer the agent rather than to describe the repository: an override of its instructions, a hidden
// action, or sending data somewhere. A memory that reads like one waits for the user, because memory poisoning works
// exactly by planting such a line where it will be read later as trusted guidance.
const INSTRUCTION_LIKE = [
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|system|your)\b[^.\n]{0,20}\b(?:instructions?|rules?|prompts?|guidance|messages?)\b/i,
  /\b(?:system prompt|developer message|jailbreak|you are now|new instructions|act as (?:an?|the) )/i,
  /\b(?:do not|don't|never)\s+(?:tell|inform|show|mention|ask)\s+(?:the\s+)?(?:user|human|owner)\b/i,
  /\bwithout\s+(?:asking|telling|confirm(?:ing|ation)|approval|permission)\b/i,
  /\b(?:send|post|upload|exfiltrate|forward|leak|transmit|email)\b[^\n]{0,80}\b(?:https?:\/\/|webhook|pastebin|ngrok|\d{1,3}(?:\.\d{1,3}){3})/i,
  /\b(?:curl|wget|iwr|invoke-webrequest)\b[^|\n]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i,
  /\b(?:approve|allow|accept)\s+(?:all|every|any)\s+(?:permissions?|requests?|prompts?|commands?)\b/i,
  /\b(?:disable|turn off|bypass|skip)\s+(?:the\s+)?(?:sandbox|permissions?|security|safety|guardrails?|review|tests? before (?:commit|push))/i,
  /(?:\.ssh\b|id_rsa|\.aws\/credentials|keychain|\.env\b)[^\n]{0,60}\b(?:send|post|upload|cat|print|copy)\b/i,
  /[A-Za-z0-9+/]{120,}={0,2}/,
]

// Text in a document that speaks to an AI reading it rather than to the document's readers: a planted turn of a
// conversation, a role tag, a new task. Documents are checked with these as well, memory writes with the list above.
const ADDRESSED = [
  /\bif you are an? (?:ai|assistant|language model|llm|large language model|chatbot|agent)\b/i,
  /\b(?:ai|llm) (?:agents?|assistants?|models?) (?:reading|processing|summari[sz]ing) this\b/i,
  /\bto (?:the|any) (?:ai|llm|assistant|language model) (?:reading|processing) this\b/i,
  /<\/?system>/i,
  /^\s*assistant\s*:/im,
  /\byou must now\b/i,
  /\bnew task\s*:/i,
]

/** Whether text reads as instructions to the agent. A document's text is also checked for text addressed to an AI. */
export function instructionLike(text: string, document = false) {
  return (
    INSTRUCTION_LIKE.some((pattern) => pattern.test(text)) ||
    (document && ADDRESSED.some((pattern) => pattern.test(text)))
  )
}
