import { describe, expect, test } from "bun:test"
import { isCredentialField } from "./browser-credential-field"

// The landing page states plainly that the browser "will not type into a
// password, one-time-code, or card field". The guard used to be reachable only
// through the typing path, so the agent's own `press` command walked around it.
// These pin the predicate every input path now shares.
describe("isCredentialField", () => {
  test("a password input is refused", () => {
    expect(isCredentialField({ type: "password" })).toBe(true)
    expect(isCredentialField({ type: "PASSWORD" })).toBe(true)
  })

  test("a masked field is refused even when it claims to be text", () => {
    // The common hand-rolled login box: type="text" with the characters masked
    // by CSS, which no attribute check can see.
    expect(isCredentialField({ type: "text", textSecurity: "disc" })).toBe(true)
    expect(isCredentialField({ type: "text", textSecurity: "none" })).toBe(false)
  })

  test("autocomplete hints for codes and cards are refused", () => {
    for (const hint of ["one-time-code", "current-password", "new-password", "cc-number", "cc-csc"]) {
      expect(isCredentialField({ type: "text", autocomplete: hint })).toBe(true)
    }
  })

  test("credential-shaped names and ids are refused whatever the type says", () => {
    for (const name of ["password", "passwd", "pwd", "otp", "totp", "mfa", "2fa", "cvv", "cvc", "card-number"]) {
      expect(isCredentialField({ type: "text", name })).toBe(true)
      expect(isCredentialField({ type: "text", id: name })).toBe(true)
    }
  })

  test("an ordinary field is allowed, so the guard does not block real work", () => {
    expect(isCredentialField({ type: "text", name: "email", id: "email" })).toBe(false)
    expect(isCredentialField({ type: "search", name: "q" })).toBe(false)
    expect(isCredentialField({})).toBe(false)
  })

  test("names are read as words, whatever separates them: snake_case, brackets and camelCase", () => {
    for (const name of [
      "password",
      "user_password",
      "passwd",
      "pwd",
      "otp",
      "one_time_code",
      "oneTimeCode",
      "verification_code",
      "verificationCode",
      "security_code",
      "card_number",
      "cardNumber",
      "cardnumber",
      "cc_number",
      "payment[cc_number]",
      "authorizenet_cc_number",
      "ccnum",
      "cvv",
      "cvc",
      "csc",
      "mfa_code",
      "2fa",
      "totp",
      "newpassword",
    ]) {
      expect({ name, refused: isCredentialField({ type: "text", name }) }).toEqual({ name, refused: true })
      expect({ id: name, refused: isCredentialField({ type: "text", id: name }) }).toEqual({ id: name, refused: true })
    }
  })

  // Names the substring match before the word reading refused, which a word reading must still refuse: a short word
  // with a digit after it (split OTP boxes, cvv2), a short word at either end of a longer one, and 2FA in capitals.
  const numbered = [
    "cvv2",
    "CVV2",
    "Cvv2",
    "cvc2",
    "card_cvv2",
    "card-cvv2",
    "cc_cvv2",
    "creditCardCvv2",
    "cvv2Number",
    "otp1",
    "otp6",
    "otp1Code",
    "pwd1",
    "totp1",
    "mfa1",
    "smsotp",
    "emailotp",
    "otpinput",
    "totpcode",
    "mfatoken",
    "userpwd",
    "loginpwd",
    "newpwd",
    "cardcvv",
    "cardcvc",
    "cardNumber1",
    "cardNumber2",
    "securityCode2",
    "verificationCode1",
    "2FA",
    "code2fa",
    "2faCode",
  ]

  test("a credential word with a digit after it, or at either end of a longer word, is still refused", () => {
    for (const name of numbered) {
      expect({ name, refused: isCredentialField({ type: "text", name }) }).toEqual({ name, refused: true })
      expect({ id: name, refused: isCredentialField({ type: "text", id: name }) }).toEqual({ id: name, refused: true })
    }
  })

  test("a word that only holds a credential word's letters is an ordinary field", () => {
    for (const name of [
      "footprint",
      "timeSlotPicker",
      "phone-time",
      "hotpot",
      "zonetime",
      "compass",
      "email",
      "q",
      "address1",
      "address2",
      "line1",
      "line2",
      "phone2",
      "zip5",
      "laptop",
      "desktop",
      "spotprice",
      "shotput",
      "notpaid",
      "cscope",
    ]) {
      expect({ name, refused: isCredentialField({ type: "text", name, id: name }) }).toEqual({ name, refused: false })
    }
  })

  test("is self-contained, so it runs when stringified into the page", () => {
    const run = new Function(`return (${isCredentialField.toString()})`)() as typeof isCredentialField
    expect(run({ type: "text", name: "payment[cc_number]" })).toBe(true)
    expect(run({ type: "text", name: "footprint" })).toBe(false)
    for (const name of numbered) expect({ name, refused: run({ type: "text", name }) }).toEqual({ name, refused: true })
    expect(run({ type: "text", name: "address1" })).toBe(false)
  })
})
