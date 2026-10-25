// The predicate behind Vector's promise that the browser never types into a
// credential field. It lives in its own module, free of electron imports, so it
// can be tested directly — browser-agent.ts pulls in WebContentsView at module
// load, which makes it unimportable from a test.
//
// It is also stringified into the injected page scripts, so it must stay a
// self-contained function with no imports or closure references.
export function isCredentialField(field: {
  type?: string | null
  autocomplete?: string | null
  name?: string | null
  id?: string | null
  textSecurity?: string | null
}) {
  if ((field.type || "").toLowerCase() === "password") return true
  // A masked field is a credential field whatever its type attribute claims.
  // The common hand-rolled login input is type="text" plus -webkit-text-security,
  // which the attribute checks below cannot see.
  if ((field.textSecurity || "none").toLowerCase() !== "none") return true
  if (/one-time-code|current-password|new-password|cc-number|cc-csc/.test((field.autocomplete || "").toLowerCase())) {
    return true
  }
  // Names and ids are read as words, split on separators, camelCase and a letter followed by a digit, so card_number,
  // payment[cc_number], oneTimeCode, cvv2 and otp1 match while footprint, timeSlotPicker and phone-time, which only hold
  // the letters, do not. A digit followed by letters stays one word (2fa). The long words count anywhere inside another
  // one (newpassword, creditcardnumber), and the short ones at either end of one (smsotp, otpinput, userpwd, cardcvv).
  // csc is left out of those ends: cscope is no field to refuse.
  const inside = ["password", "passwd", "cardnumber", "verificationcode", "securitycode", "onetimecode"]
  const ends = ["pwd", "otp", "totp", "mfa", "cvv", "cvc"]
  const words = new Set([
    "pwd",
    "otp",
    "otpcode",
    "totp",
    "mfa",
    "mfacode",
    "2fa",
    "cvv",
    "cvc",
    "csc",
    "ccnum",
    "ccnumber",
    "onetime",
  ])
  const pairs = new Set(["one time", "verification code", "security code", "card number", "cc num", "cc number"])
  return [field.name, field.id].some((value) => {
    const tokens = (value || "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
      .replace(/([a-zA-Z])(\d)/g, "$1 $2")
      .toLowerCase()
      .split(/[-_\s[\].:]+/)
      .filter(Boolean)
    return tokens.some(
      (token, index) =>
        inside.some((word) => token.includes(word)) ||
        words.has(token) ||
        ends.some((word) => token.startsWith(word) || token.endsWith(word)) ||
        pairs.has(`${token} ${tokens[index + 1] ?? ""}`),
    )
  })
}
