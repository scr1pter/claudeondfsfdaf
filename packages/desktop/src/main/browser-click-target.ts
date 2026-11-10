// What a click on a selector would press, as the page names it. The engine
// asks again before a click on an external page whose target reads like a
// release, payment or settings action (`Promote`, `Instant Rollback`, `Save`).
// A positional selector such as `div[role=dialog] button:last-child` says
// nothing about that, so the engine reads the element's own name from here
// before it decides. A click on an icon or span inside a button presses the
// button, so the nearest clickable ancestor's name counts too. Names are read
// as observe reads them (aria-label, aria-labelledby, an image's alt, title),
// and a field's value counts only for a button-like input: what a text or
// password field holds is never a name.
//
// It is stringified into the injected page script, like isCredentialField, so
// it must stay a self-contained function with no imports or closure references.
export function clickTargetLabel(element: Element) {
  const control =
    element.closest(
      'button, a, summary, label, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], [role="switch"], [role="checkbox"], input[type="submit"], input[type="button"], input[type="reset"], input[type="image"]',
    ) ?? element
  const text = (node: Element | null) => (node ? ((node as HTMLElement).innerText ?? node.textContent) : null)
  const names = (control === element ? [element] : [control, element]).flatMap((node) => {
    const root = node.getRootNode() as Document | ShadowRoot
    const type = (node.getAttribute("type") ?? "").toLowerCase()
    const button = node.localName === "input" && ["submit", "button", "reset"].includes(type)
    return [
      node.getAttribute("aria-label"),
      ...(node.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => text(root.getElementById?.(id) ?? node.ownerDocument.getElementById(id))),
      node.getAttribute("alt"),
      ...Array.from(node.querySelectorAll("img[alt], input[type='image'][alt]")).map((image) =>
        image.getAttribute("alt"),
      ),
      node.getAttribute("title"),
      button ? (node as HTMLInputElement).value : null,
      text(node),
    ]
  })
  return names
    .filter((name): name is string => typeof name === "string" && name.trim() !== "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300)
}
