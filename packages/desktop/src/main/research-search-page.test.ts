import { describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { ResearchSearch } from "@vectordevai/core/research/search"
import { readSearchPage, searchOutcome, type SearchPageRead } from "./research-search-page"

// Reading search engines' results pages (section 5.7), against hand-written pages shaped like Google's and
// DuckDuckGo's HTML results, in happy-dom (a DOM for tests). No live page is fetched. The page script
// runs as the research browser runs it: serialized with toString() and rebuilt with no access to this module.

GlobalRegistrator.register({ url: "https://www.google.com/" })

const inPage = <T extends (...input: never[]) => unknown>(fn: T) => new Function(`return (${fn.toString()})`)() as T
const read = inPage(readSearchPage)

// A page at an address, as the research browser shows it.
const page = (url: string, html: string) => {
  ;(globalThis as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(url)
  document.open()
  document.write(html)
  document.close()
  return window
}
const GOOGLE = "https://www.google.com/search?q=heat+pumps+cold+climates"
const DDG = "https://html.duckduckgo.com/html/?q=heat+pumps+cold+climates"

// Google's results page, as its markup is shaped: ads above and below, an organic result whose link Google wraps in
// /url?q=, one with its snippet only in the block's text, a "People also ask" block whose expanded answer holds a
// link, a block of the column headed "People also ask" with no class to know it by, the side panel, related searches
// and Google's own links.
const GOOGLE_RESULTS = `<!doctype html><html><head><title>heat pumps cold climates - Google Search</title></head><body>
<div role="navigation"><a href="/search?q=heat+pumps&tbm=isch"><h3>Images</h3></a></div>
<div id="search"><div id="tads" aria-label="Ads">
  <div class="uEierd"><a href="https://www.googleadservices.com/pagead/aclk?sa=L&adurl=https://buyheatpumps.example.com"><h3>Buy heat pumps today</h3></a>
  <div class="VwiC3b">Sponsored: the best prices.</div></div>
</div>
<div id="rso">
  <div class="MjjYud"><div class="g" data-hveid="CAE">
    <a jsname="UWckNb" href="https://www.energy.gov/heat-pumps-cold-climates"><h3 class="LC20lb">Heat Pumps in Cold Climates | Department of Energy</h3><cite>https://www.energy.gov › heat-pumps</cite></a>
    <div class="VwiC3b" style="-webkit-line-clamp:2"><span>Air-source heat pumps work well in cold climates.</span> <span>Field tests show savings.</span></div>
  </div></div>
  <div class="MjjYud"><div class="g">
    <a href="/url?q=https://www.nature.com/articles/heat-pump-study&sa=U&ved=2ah"><h3>A field study of heat pumps in 412 homes</h3></a>
    <div class="VwiC3b">The study followed 412 homes through two winters.</div>
  </div></div>
  <div class="MjjYud"><div class="related-question-pair" data-initq="are heat pumps worth it">
    <div role="button">Are heat pumps worth it in cold climates?</div>
    <div><a href="https://answers.example.com/worth-it"><h3>Are heat pumps worth it?</h3></a></div>
  </div></div>
  <div class="MjjYud"><div jscontroller="x"><h2 role="heading">People also ask</h2>
    <div><a href="https://questions.example.com/how-cold"><h3>How cold is too cold for a heat pump?</h3></a></div>
  </div></div>
  <div class="MjjYud"><div class="g">
    <a href="https://www.example.org/heat-pump-guide"><h3>The cold-climate heat pump guide</h3></a>
    <span>example.org</span> A plain guide to sizing a heat pump for a cold house.
  </div></div>
  <div class="MjjYud"><div class="g">
    <a href="https://www.energy.gov/heat-pumps-cold-climates#savings"><h3>Heat pump savings (same page)</h3></a>
  </div></div>
  <div class="MjjYud"><div class="g">
    <a href="https://www.google.com/search?q=heat+pump+cost"><h3>heat pump cost</h3></a>
  </div></div>
</div>
<div id="bottomads"><a href="https://www.googleadservices.com/pagead/aclk?sa=X"><h3>More heat pump deals</h3></a></div>
<div id="botstuff"><a href="/search?q=best+heat+pumps"><h3>Related searches</h3></a></div>
<div id="rhs"><a href="https://en.wikipedia.org/wiki/Heat_pump"><h3>Heat pump</h3></a></div>
</div>
<footer><a href="https://policies.google.com/privacy"><h3>Privacy</h3></a></footer>
</body></html>`

describe("Google's results page", () => {
  test("gives its organic results only: no ads, no People also ask, no side panel and none of Google's own links", () => {
    const shown = read(page(GOOGLE, GOOGLE_RESULTS), "google")
    expect(shown.title).toBe("heat pumps cold climates - Google Search")
    expect(shown.check).toBeUndefined()
    const outcome = searchOutcome("google", shown)
    expect(outcome).toEqual({
      kind: "results",
      results: [
        {
          url: "https://www.energy.gov/heat-pumps-cold-climates",
          title: "Heat Pumps in Cold Climates | Department of Energy",
          snippet: "Air-source heat pumps work well in cold climates. Field tests show savings.",
        },
        {
          url: "https://www.nature.com/articles/heat-pump-study",
          title: "A field study of heat pumps in 412 homes",
          snippet: "The study followed 412 homes through two winters.",
        },
        {
          url: "https://www.example.org/heat-pump-guide",
          title: "The cold-climate heat pump guide",
          snippet: "example.org A plain guide to sizing a heat pump for a cold house.",
        },
      ],
    })
  })

  test("results wrapped in one block of the column with a People also ask module are kept; the module's are not", () => {
    // Google may put several modules in one child of #rso: two organic results, a "People also ask" module (one with
    // the class Vector knows it by, one with only its heading) and a sponsored block, all in one wrapper.
    const wrapped = `<html><body><div id="search"><div id="rso"><div class="dURPMd">
  <div class="MjjYud"><div class="g"><a href="https://www.energy.gov/a"><h3>Energy A</h3></a><div class="VwiC3b">Snippet A.</div></div></div>
  <div class="MjjYud"><div jscontroller="x"><div role="heading" aria-level="2">People also ask</div>
    <div class="related-question-pair"><a href="https://q.example.com/x"><h3>A question</h3></a></div></div></div>
  <div class="MjjYud"><div jscontroller="y"><h2>People also ask</h2>
    <div><a href="https://q.example.com/y"><h3>Another question</h3></a></div>
    <div><a href="https://q.example.com/z"><h3>A third question</h3></a></div></div></div>
  <div class="MjjYud"><div class="g"><a href="https://www.nature.com/b"><h3>Nature B</h3></a><div class="VwiC3b">Snippet B.</div></div></div>
  <div class="MjjYud"><h2 role="heading">Sponsored</h2><div class="g"><a href="https://shop.example.com/c"><h3>Buy C</h3></a></div></div>
</div></div></div></body></html>`
    expect(searchOutcome("google", read(page(GOOGLE, wrapped), "google"))).toEqual({
      kind: "results",
      results: [
        { url: "https://www.energy.gov/a", title: "Energy A", snippet: "Snippet A." },
        { url: "https://www.nature.com/b", title: "Nature B", snippet: "Snippet B." },
      ],
    })
  })

  test("keeps to the limit", () => {
    const outcome = searchOutcome("google", read(page(GOOGLE, GOOGLE_RESULTS), "google"), 1)
    expect(outcome.kind === "results" ? outcome.results.map((item) => item.url) : []).toEqual([
      "https://www.energy.gov/heat-pumps-cold-climates",
    ])
  })

  test("a page that says it found nothing gives no results, and no fallback", () => {
    const none = `<html><body><div id="topstuff"><div class="card-section"><p>Your search - <em>qwzxv heat</em> - did not match any documents.</p></div></div><div id="rso"></div></body></html>`
    expect(searchOutcome("google", read(page(GOOGLE, none), "google"))).toEqual({ kind: "results", results: [] })
  })

  test("a page Vector cannot read is said to be so, so the next engine is tried", () => {
    const blank = `<html><body><div id="main"><p>Something went wrong.</p></div></body></html>`
    expect(searchOutcome("google", read(page(GOOGLE, blank), "google")).kind).toBe("unreadable")
  })
})

describe("checks and consent walls", () => {
  test("Google's unusual traffic page is a check, by its address and by what it shows", () => {
    const sorry = `<html><head><title>https://www.google.com/search?q=heat</title></head><body>
<div id="captcha-form"><form action="index" method="post"><div class="g-recaptcha" data-sitekey="6LfwuyUTAAAAAOAmoS0fdqijC2PbbdH4kjq62Y1b"></div></form></div>
<div>Our systems have detected unusual traffic from your computer network. This page checks to see if it's really you sending the requests, and not a robot.</div>
</body></html>`
    const atSorry = read(
      page("https://www.google.com/sorry/index?continue=https://www.google.com/search", sorry),
      "google",
    )
    expect(atSorry.check).toBe("captcha")
    expect(searchOutcome("google", atSorry)).toEqual({
      kind: "blocked",
      reason: "Google asked for a check that it is not automated traffic.",
    })
    // The same words on the results page's own address, with no element to know it by.
    const words = read(
      page(
        GOOGLE,
        "<html><body><p>Our systems have detected unusual traffic from your computer network.</p></body></html>",
      ),
      "google",
    )
    expect(words.check).toBeUndefined()
    expect(searchOutcome("google", words).kind).toBe("blocked")
  })

  test("a consent wall, at consent.google.com or over the page, is not clicked through", () => {
    const wall = `<html><body><h1>Before you continue to Google</h1><form action="https://consent.google.com/save" method="post"><button id="L2AGLb">Accept all</button><button id="W0wltc">Reject all</button></form></body></html>`
    expect(
      searchOutcome(
        "google",
        read(page("https://consent.google.com/ml?continue=https://www.google.com/search", wall), "google"),
      ),
    ).toEqual({
      kind: "blocked",
      reason: "Google showed a consent page.",
    })
    // Over a results page: the results under it are not read either.
    const over = GOOGLE_RESULTS.replace(
      "<body>",
      `<body><div aria-label="Before you continue to Google Search"><button id="L2AGLb">Accept all</button></div>`,
    )
    expect(searchOutcome("google", read(page(GOOGLE, over), "google"))).toEqual({
      kind: "blocked",
      reason: "Google showed a consent page.",
    })
  })

  test("a snippet that mentions a captcha is a result, not a check", () => {
    const html = `<html><body><div id="rso"><div class="g"><a href="https://example.org/captcha-history"><h3>A history of the CAPTCHA</h3></a><div class="VwiC3b">Why sites ask you to prove you are not a robot.</div></div></div></body></html>`
    expect(searchOutcome("google", read(page(GOOGLE, html), "google")).kind).toBe("results")
  })

  test("DuckDuckGo's bot check is a check", () => {
    const anomaly = `<html><body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div><div class="anomaly-modal__description">Please complete the following challenge to confirm this search was made by a human.</div><form action="/anomaly.js" method="post"></form></body></html>`
    const shown = read(page(DDG, anomaly), "duckduckgo")
    expect(shown.check).toBe("captcha")
    expect(searchOutcome("duckduckgo", shown)).toEqual({
      kind: "blocked",
      reason: "DuckDuckGo asked for a check that it is not automated traffic.",
    })
  })
})

// DuckDuckGo's HTML results page: an ad, organic results whose links go through /l/?uddg=, and one linked directly.
const DDG_RESULTS = `<!doctype html><html><head><title>heat pumps cold climates at DuckDuckGo</title></head><body>
<form id="search_form" action="/html/" method="post"><input name="q" value="heat pumps cold climates"></form>
<div id="links" class="results">
  <div class="result results_links results_links_deep result--ad">
    <div class="result__body"><h2 class="result__title"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=buyheatpumps.example.com">Buy heat pumps</a></h2>
    <a class="result__snippet" href="https://duckduckgo.com/y.js?ad_domain=buyheatpumps.example.com">Sponsored deals.</a><span class="badge--ad">Ad</span></div>
  </div>
  <div class="result results_links results_links_deep web-result">
    <div class="result__body"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.energy.gov%2Fheat%2Dpumps%2Dcold%2Dclimates&amp;rut=abc">Heat Pumps in Cold Climates | <b>Department</b> of Energy</a></h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.energy.gov%2Fheat%2Dpumps%2Dcold%2Dclimates">Air-source <b>heat pumps</b> work well in cold climates.</a></div>
  </div>
  <div class="result results_links results_links_deep web-result">
    <div class="result__body"><h2 class="result__title"><a class="result__a" href="https://www.example.org/heat-pump-guide">The cold-climate heat pump guide</a></h2>
    <div class="result__snippet">A plain guide.</div></div>
  </div>
</div></body></html>`

describe("DuckDuckGo's HTML results page", () => {
  test("gives its organic results with DuckDuckGo's redirect links unwrapped, and no ads", () => {
    const shown = read(page(DDG, DDG_RESULTS), "duckduckgo")
    expect(searchOutcome("duckduckgo", shown)).toEqual({
      kind: "results",
      results: [
        {
          url: "https://www.energy.gov/heat-pumps-cold-climates",
          title: "Heat Pumps in Cold Climates | Department of Energy",
          snippet: "Air-source heat pumps work well in cold climates.",
        },
        {
          url: "https://www.example.org/heat-pump-guide",
          title: "The cold-climate heat pump guide",
          snippet: "A plain guide.",
        },
      ],
    })
  })

  test("its no-results page gives no results", () => {
    const none = `<html><body><div id="links" class="results"><div class="no-results">No results.</div></div></body></html>`
    expect(searchOutcome("duckduckgo", read(page(DDG, none), "duckduckgo"))).toEqual({ kind: "results", results: [] })
  })
})

describe("what the page script cannot be fooled by", () => {
  test("a named element standing in for a DOM method changes nothing", () => {
    const html = GOOGLE_RESULTS.replace(
      '<div id="rso">',
      '<form name="querySelectorAll"><input name="getAttribute"></form><img name="querySelectorAll"><div id="rso">',
    )
    const outcome = searchOutcome("google", read(page(GOOGLE, html), "google"))
    expect(outcome.kind === "results" ? outcome.results.length : 0).toBe(3)
  })

  test("only web addresses come back, whatever a link says", () => {
    const shown: SearchPageRead = {
      url: GOOGLE,
      title: "",
      none: false,
      text: "",
      items: [
        { href: "javascript:alert(1)", title: "Script", snippet: "" },
        { href: "/url?q=javascript:alert(1)", title: "Wrapped script", snippet: "" },
        { href: "data:text/html,hi", title: "Data", snippet: "" },
        { href: "/url?q=https://example.org/ok", title: "Fine", snippet: "" },
      ],
    }
    expect(searchOutcome("google", shown)).toEqual({
      kind: "results",
      results: [{ url: "https://example.org/ok", title: "Fine", snippet: "" }],
    })
    expect(ResearchSearch.NAMES.duckduckgo).toBe("DuckDuckGo")
  })
})
