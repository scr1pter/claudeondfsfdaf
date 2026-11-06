// The credential guard (contract WP A54). hostd injects this script over the browser's debugging pipe into an isolated
// world ("vector-guard") of every frame of the cloud computer's browser, so pages can neither see nor change it. hostd
// asks it two things before an agent action:
//   focused()   whether the focused field takes a password, a one-time code or card details. hostd then refuses to type
//               into it and hands the computer to the person (credential fields are always the person's).
//   captchas()  where CAPTCHA challenges are on the screen. hostd refuses to press inside them and hands over.
// It reads the page and never changes it. It runs in pages, so it is plain browser JavaScript with no imports.
;(function () {
  "use strict"

  var SECRET_AUTOCOMPLETE = ["current-password", "new-password", "one-time-code"]
  var PASSWORD_WORDS = /(^|[^a-z])(password|passwd|passphrase|pwd|pin)([^a-z]|$)/i
  var CODE_WORDS =
    /(^|[^a-z])(otp|totp|2fa|mfa|one[\s_-]?time|verification[\s_-]?code|verify[\s_-]?code|security[\s_-]?code|auth(entication)?[\s_-]?code|sms[\s_-]?code|passcode|confirmation[\s_-]?code)([^a-z]|$)/i
  var CARD_WORDS =
    /(^|[^a-z])(card[\s_-]?(number|no|num)|cc[\s_-]?(number|num|no)|credit[\s_-]?card|debit[\s_-]?card|cvv2?|cvc2?|csc|card[\s_-]?verification|card[\s_-]?code|security[\s_-]?number|expir(y|ation)([\s_-]?date)?|exp[\s_-]?(date|month|year)|iban|routing[\s_-]?number|account[\s_-]?number)([^a-z]|$)/i
  var CAPTCHA_HOSTS = [
    /(^|\.)google\.com$/,
    /(^|\.)recaptcha\.net$/,
    /(^|\.)hcaptcha\.com$/,
    /^challenges\.cloudflare\.com$/,
    /(^|\.)arkoselabs\.com$/,
    /(^|\.)funcaptcha\.com$/,
    /(^|\.)geetest\.com$/,
    /(^|\.)captcha-delivery\.com$/,
  ]
  var CAPTCHA_ELEMENTS = ".g-recaptcha, .h-captcha, .cf-turnstile, #px-captcha, [data-hcaptcha-widget-id]"
  var MARGIN = 16

  function lower(value) {
    return typeof value === "string" ? value.toLowerCase() : ""
  }

  /**
   * What kind of secret a field takes, from its attributes alone: "credential" (passwords and one-time codes),
   * "payment_details" (card and bank details) or null.
   */
  function classify(field) {
    if (!field) return null
    var tag = lower(field.tag)
    if (tag !== "input" && tag !== "textarea" && !field.editable) return null
    var type = lower(field.type)
    if (type === "password") return "credential"
    if (type === "hidden" || type === "checkbox" || type === "radio" || type === "submit" || type === "button") return null
    var autocomplete = lower(field.autocomplete).split(/\s+/)
    for (var i = 0; i < autocomplete.length; i++) {
      if (SECRET_AUTOCOMPLETE.indexOf(autocomplete[i]) >= 0) return "credential"
      if (autocomplete[i].indexOf("cc-") === 0) return "payment_details"
    }
    var words = [field.name, field.id, field.label, field.placeholder, field.ariaLabel]
      .map(function (value) {
        return typeof value === "string" ? value.replace(/([a-z])([A-Z])/g, "$1 $2") : ""
      })
      .join(" | ")
    if (CARD_WORDS.test(words)) return "payment_details"
    if (CODE_WORDS.test(words)) return "credential"
    if (PASSWORD_WORDS.test(words)) return "credential"
    return null
  }

  /** Whether a frame's address is a CAPTCHA provider's challenge. */
  function captchaUrl(src) {
    var url
    try {
      url = new URL(src)
    } catch (error) {
      return false
    }
    var host = url.hostname.toLowerCase()
    for (var i = 0; i < CAPTCHA_HOSTS.length; i++) {
      if (!CAPTCHA_HOSTS[i].test(host)) continue
      if (/(^|\.)google\.com$/.test(host)) return url.pathname.indexOf("/recaptcha") === 0
      return true
    }
    return false
  }

  function labelOf(element) {
    try {
      if (element.labels && element.labels.length) return element.labels[0].textContent || ""
      var id = element.getAttribute && element.getAttribute("aria-labelledby")
      if (id && element.ownerDocument) {
        var node = element.ownerDocument.getElementById(id)
        if (node) return node.textContent || ""
      }
    } catch (error) {}
    return ""
  }

  function describe(element) {
    if (!element) return null
    var attr = function (name) {
      return (element.getAttribute && element.getAttribute(name)) || ""
    }
    return {
      tag: element.tagName,
      type: element.type || attr("type"),
      autocomplete: attr("autocomplete"),
      name: attr("name"),
      id: element.id || attr("id"),
      label: labelOf(element).slice(0, 200),
      placeholder: attr("placeholder"),
      ariaLabel: attr("aria-label"),
      editable: element.isContentEditable === true,
    }
  }

  /** The focused element, looking through open shadow roots. */
  function deepActive(doc) {
    var active = doc.activeElement
    while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement
    return active
  }

  /** What the focused field in this frame takes, while this frame has the keyboard: {kind} or {kind: null}. */
  function focused() {
    var doc = globalThis.document
    if (!doc || typeof doc.hasFocus !== "function" || !doc.hasFocus()) return { kind: null }
    var active = deepActive(doc)
    if (!active || lower(active.tagName) === "iframe" || lower(active.tagName) === "frame") return { kind: null }
    return { kind: classify(describe(active)) }
  }

  /** The window's content origin on the screen, in screen pixels. */
  function origin() {
    var w = globalThis
    var border = Math.max(0, (w.outerWidth - w.innerWidth) / 2)
    return { x: w.screenX + border, y: w.screenY + Math.max(0, w.outerHeight - w.innerHeight - border), ratio: w.devicePixelRatio || 1 }
  }

  /** Where CAPTCHA challenges are in this frame, as screen rectangles with a margin, while the frame is visible. */
  function captchas() {
    var doc = globalThis.document
    if (!doc || doc.visibilityState === "hidden") return []
    var at = origin()
    var found = []
    var push = function (rect) {
      if (!rect || rect.width < 2 || rect.height < 2) return
      found.push({
        x: Math.floor(at.x + rect.left * at.ratio) - MARGIN,
        y: Math.floor(at.y + rect.top * at.ratio) - MARGIN,
        w: Math.ceil(rect.width * at.ratio) + 2 * MARGIN,
        h: Math.ceil(rect.height * at.ratio) + 2 * MARGIN,
      })
    }
    try {
      var frames = doc.querySelectorAll("iframe, frame")
      for (var i = 0; i < frames.length; i++) if (captchaUrl(frames[i].src)) push(frames[i].getBoundingClientRect())
      var widgets = doc.querySelectorAll(CAPTCHA_ELEMENTS)
      for (var j = 0; j < widgets.length; j++) push(widgets[j].getBoundingClientRect())
      if (globalThis.top === globalThis && captchaUrl(globalThis.location.href))
        push({ left: 0, top: 0, width: globalThis.innerWidth, height: globalThis.innerHeight })
    } catch (error) {}
    return found
  }

  globalThis.__vectorGuard = Object.freeze({ version: 1, classify: classify, captchaUrl: captchaUrl, focused: focused, captchas: captchas })
})()
