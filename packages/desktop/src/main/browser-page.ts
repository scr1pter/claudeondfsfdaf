// What Vector runs inside a page to read it and to find what to click or type into, for the research browsers and the
// visible agent browser alike. Each export is a self-contained function: it is serialized into the page with
// toString(), so it reads nothing from module scope, and it takes the page's window as its first argument, so tests
// can run it against a DOM of their own. They run in an isolated JavaScript world, which shares the page's DOM but not
// its globals: a page cannot replace the functions they call, and cannot read the handles observe keeps.
//
// Reading leaves out what a reader does not see (display none, hidden, transparent, zero-size clipped and off-screen
// text), scripts but the page's JSON-LD, form fields, and frames of another origin, which are not the page the agent
// opened. Open shadow roots are read as they render, slots filled. Links are absolute. Observing names the controls a
// person could use, each with a ref_N handle, in the top document, its open shadow roots and frames of its own origin
// only, so a click or a keystroke never reaches a frame of another origin.
//
// A form's named fields shadow its own properties and methods in every world, the isolated one included: in a form
// holding <input name="elements"> or name="getAttribute", form.elements and form.getAttribute are those fields. So what
// these functions read of an element that may be a form goes through the DOM's prototypes.

export type PageLink = {
  readonly url: string
  readonly text: string
  /** Inside the page's main content: main, article or role=main. */
  readonly main: boolean
}

export type PageRead = {
  readonly html: string
  readonly title: string
  readonly url: string
  readonly links: readonly PageLink[]
  /** GET form targets, as origin and path. */
  readonly forms: readonly string[]
  readonly truncated: boolean
}

export type ObservedElement = {
  readonly ref: string
  readonly role: string
  readonly name: string
  readonly tag: string
  readonly type?: string
  readonly href?: string
  readonly disabled?: boolean
}

export type Observed = {
  readonly title: string
  readonly url: string
  readonly text: string
  readonly elements: readonly ObservedElement[]
  readonly links: readonly PageLink[]
  readonly forms: readonly string[]
}

export type ClickPoint =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly x: number; readonly y: number; readonly hit: boolean; readonly href?: string }

export type Typing = { readonly ok: true } | { readonly ok: false; readonly reason: string }

type Field = {
  type?: string | null
  autocomplete?: string | null
  name?: string | null
  id?: string | null
  textSecurity?: string | null
}

/** The page as HTML for the research reader: what a reader sees, absolute links, and the page's own metadata. */
export function readPage(win: Window, options: { readonly maxBytes: number }): PageRead {
  const SKIP = new Set([
    "style",
    "noscript",
    "template",
    "object",
    "embed",
    "applet",
    "canvas",
    "svg",
    "math",
    "video",
    "audio",
    "source",
    "track",
    "input",
    "select",
    "textarea",
    "option",
    "datalist",
    "map",
    "area",
    "base",
    "link",
    "meta",
    "head",
    "title",
  ])
  const VOID = new Set(["br", "hr", "img", "wbr"])
  const KEEP: Record<string, readonly string[]> = {
    a: ["href"],
    img: ["alt"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan", "scope"],
    time: ["datetime"],
    ol: ["start"],
    li: ["value"],
    abbr: ["title"],
  }
  const top = win.document
  // What the node's prototypes define under `key`, never a property of its own: an accessor read, or a method called.
  const inherited = (owner: object, key: string): PropertyDescriptor =>
    Object.getOwnPropertyDescriptor(owner, key) ?? inherited(Object.getPrototypeOf(owner), key)
  const property = (target: object, key: string) => inherited(Object.getPrototypeOf(target), key).get!.call(target)
  const invoke = (target: object, key: string, ...input: unknown[]) =>
    (inherited(Object.getPrototypeOf(target), key).value as (...input: unknown[]) => unknown).apply(target, input)
  const attribute = (element: Element, name: string) => invoke(element, "getAttribute", name) as string | null
  const tagOf = (element: Element) => property(element, "localName") as string
  const out: string[] = []
  const state = { size: 0, truncated: false }
  const links: PageLink[] = []
  const forms: string[] = []
  // The text the walk keeps inside each link it is in, innermost last: a link is named by what a reader sees of it.
  const anchors: string[][] = []
  const push = (text: string) => {
    if (state.truncated) return
    if (state.size + text.length > options.maxBytes) {
      state.truncated = true
      return
    }
    out.push(text)
    state.size += text.length
  }
  const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const quote = (text: string) => escape(text).replace(/"/g, "&quot;")
  const web = (url: string) => /^https?:\/\//i.test(url)
  const line = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim()
  // Layout is there in a browser; a DOM without one (a test's) reads styles only.
  const laidOut = top.documentElement.getBoundingClientRect().width > 0
  // "none": the element and what it holds are left out. "text": its own text is, but not its children, which may be
  // made visible again. "shown": kept.
  const shown = (element: Element) => {
    const view = (property(element, "ownerDocument") as Document).defaultView ?? win
    const style = view.getComputedStyle(element)
    if (invoke(element, "hasAttribute", "hidden") || style.display === "none") return "none"
    if (
      (style.opacity !== "" && Number(style.opacity) === 0) ||
      style.fontSize === "0px" ||
      /^(?:transparent|rgba\(.*,\s*0\))$/.test(style.color)
    )
      return "none"
    if (laidOut) {
      const rect = invoke(element, "getBoundingClientRect") as DOMRect
      const placed = style.position === "absolute" || style.position === "fixed"
      if (placed && (rect.right + view.scrollX <= 0 || rect.bottom + view.scrollY <= 0)) return "none"
      if (
        rect.width <= 1 &&
        rect.height <= 1 &&
        (style.overflow === "hidden" || (style.clip ?? "").startsWith("rect(0"))
      )
        return "none"
    }
    if (style.visibility === "hidden" || style.visibility === "collapse") return "text"
    return "shown"
  }
  const form = (element: Element) => {
    if ((attribute(element, "method") ?? "get").toLowerCase() !== "get") return
    const action = String(property(element, "action") || (property(element, "ownerDocument") as Document).URL)
    // An action that does not parse reads back as written, which can still start with http.
    if (!web(action) || !URL.canParse(action)) return
    const address = new URL(action)
    forms.push(`${address.origin}${address.pathname}`)
  }
  const walk = (node: Node, depth: number, text: boolean, main: boolean) => {
    if (state.truncated || depth > 200) return
    const type = property(node, "nodeType")
    if (type === 3) {
      if (!text) return
      push(escape(node.nodeValue ?? ""))
      anchors.forEach((parts) => parts.push(node.nodeValue ?? ""))
      return
    }
    if (type !== 1) return
    const element = node as Element
    const tag = tagOf(element)
    if (tag === "script") {
      if ((attribute(element, "type") ?? "").trim().toLowerCase() === "application/ld+json")
        push(`<script type="application/ld+json">${(element.textContent ?? "").replace(/</g, "\\u003c")}</script>`)
      return
    }
    if (SKIP.has(tag)) return
    const how = shown(element)
    if (how === "none") return
    const inside = main || tag === "main" || tag === "article" || attribute(element, "role") === "main"
    if (tag === "form") form(element)
    if (tag === "iframe" || tag === "frame") {
      // Null for a frame of another origin, whose page is not the one the agent opened.
      const inner = (element as HTMLIFrameElement).contentDocument
      if (!inner?.body) return
      push("<section>")
      inner.body.childNodes.forEach((child) => walk(child, depth + 1, true, inside))
      push("</section>")
      return
    }
    // A link hidden itself is no link a reader can follow, whatever it holds that shows.
    const href = tag === "a" && how === "shown" ? (element as HTMLAnchorElement).href : ""
    const link = web(href) ? [] : undefined
    // Custom elements and anything else unusual read as a block.
    const name = /^[a-z][a-z0-9]*$/.test(tag) ? tag : "div"
    const attributes = (KEEP[tag] ?? [])
      .flatMap((key) => {
        const value = key === "href" ? (element as HTMLAnchorElement).href : attribute(element, key)
        if (!value || (key === "href" && (!web(value) || how !== "shown"))) return []
        return [` ${key}="${quote(value)}"`]
      })
      .join("")
    push(`<${name}${attributes}>`)
    if (VOID.has(tag)) return
    const slot = tag === "slot" ? (element as HTMLSlotElement).assignedNodes({ flatten: true }) : []
    const shadow = property(element, "shadowRoot") as ShadowRoot | null
    const children: NodeListOf<ChildNode> | Node[] = shadow
      ? shadow.childNodes
      : slot.length > 0
        ? slot
        : (property(element, "childNodes") as NodeListOf<ChildNode>)
    if (link) anchors.push(link)
    children.forEach((child) => walk(child, depth + 1, how === "shown", inside))
    if (link) {
      anchors.pop()
      links.push({ url: href, text: line(link.join("")).slice(0, 120), main: inside })
    }
    push(`</${name}>`)
  }

  ;[
    `<title>${escape(top.title)}</title>`,
    ...Array.from(top.querySelectorAll("meta[content]")).flatMap((meta) => {
      const key = ["name", "property", "itemprop"].find((attribute) => meta.hasAttribute(attribute))
      return key
        ? [
            `<meta ${key}="${quote(meta.getAttribute(key) ?? "")}" content="${quote(meta.getAttribute("content") ?? "")}">`,
          ]
        : []
    }),
    ...Array.from(top.querySelectorAll("link[rel~='canonical'][href]")).flatMap((link) => {
      const href = (link as HTMLLinkElement).href
      return web(href) ? [`<link rel="canonical" href="${quote(href)}">`] : []
    }),
  ].forEach(push)
  Array.from(top.head?.querySelectorAll("script") ?? []).forEach((script) => walk(script, 0, true, false))
  push("</head><body>")
  top.body?.childNodes.forEach((child) => walk(child, 1, true, false))
  push("</body>")
  const lang = top.documentElement.getAttribute("lang")
  return {
    html: `<!doctype html><html${lang ? ` lang="${quote(lang)}"` : ""}><head>${out.join("")}</html>`,
    title: line(top.title),
    url: win.location.href,
    links: links.filter((link, index) => links.findIndex((other) => other.url === link.url) === index).slice(0, 500),
    forms: [...new Set(forms)],
    truncated: state.truncated,
  }
}

/** The page's text and its controls, each with a ref_N handle that click and type take. */
export function observePage(
  win: Window,
  options: { readonly maxText: number; readonly maxElements: number },
): Observed {
  const ROLES = new Set([
    "button",
    "link",
    "checkbox",
    "radio",
    "switch",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "combobox",
    "textbox",
    "searchbox",
    "slider",
    "spinbutton",
    "treeitem",
  ])
  const SKIP = new Set(["script", "style", "noscript", "template", "head", "svg", "math"])
  const top = win.document
  // What the node's prototypes define under `key`, never a property of its own: an accessor read, or a method called.
  const inherited = (owner: object, key: string): PropertyDescriptor =>
    Object.getOwnPropertyDescriptor(owner, key) ?? inherited(Object.getPrototypeOf(owner), key)
  const property = (target: object, key: string) => inherited(Object.getPrototypeOf(target), key).get!.call(target)
  const invoke = (target: object, key: string, ...input: unknown[]) =>
    (inherited(Object.getPrototypeOf(target), key).value as (...input: unknown[]) => unknown).apply(target, input)
  const attribute = (element: Element, name: string) => invoke(element, "getAttribute", name) as string | null
  const tagOf = (element: Element) => property(element, "localName") as string
  const refs = new Map<string, Element>()
  ;(win as unknown as { __vectorRefs?: Map<string, Element> }).__vectorRefs = refs
  const elements: ObservedElement[] = []
  const links: PageLink[] = []
  const forms: string[] = []
  const web = (url: string) => /^https?:\/\//i.test(url)
  const line = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim()
  const laidOut = top.documentElement.getBoundingClientRect().width > 0
  const visible = (element: Element) => {
    const view = (property(element, "ownerDocument") as Document).defaultView ?? win
    const style = view.getComputedStyle(element)
    if (invoke(element, "hasAttribute", "hidden") || style.display === "none" || style.visibility === "hidden")
      return false
    if (style.opacity !== "" && Number(style.opacity) === 0) return false
    if (!laidOut) return true
    const rect = invoke(element, "getBoundingClientRect") as DOMRect
    return rect.width > 0 || rect.height > 0 || style.display === "contents"
  }
  const typeOf = (element: Element) => (attribute(element, "type") ?? "").toLowerCase()
  const roleOf = (element: Element) => {
    const explicit = (attribute(element, "role") ?? "").trim().split(/\s+/)[0] ?? ""
    if (explicit) return explicit
    const tag = tagOf(element)
    const type = typeOf(element)
    if (tag === "a") return "link"
    if (tag === "button" || tag === "summary") return "button"
    if (tag === "select") return "combobox"
    if (tag === "textarea") return "textbox"
    if (tag === "input") {
      if (["button", "submit", "reset", "image"].includes(type)) return "button"
      if (type === "checkbox" || type === "radio") return type
      if (type === "search") return "searchbox"
      if (type === "range") return "slider"
      return "textbox"
    }
    if (attribute(element, "contenteditable") === "true" || attribute(element, "contenteditable") === "")
      return "textbox"
    return "button"
  }
  const interactive = (element: Element) => {
    const tag = tagOf(element)
    if (tag === "a") return web((element as HTMLAnchorElement).href)
    if (tag === "button" || tag === "select" || tag === "textarea" || tag === "summary") return true
    if (tag === "input") return typeOf(element) !== "hidden"
    if (ROLES.has((attribute(element, "role") ?? "").trim().split(/\s+/)[0] ?? "")) return true
    const editable = attribute(element, "contenteditable")
    return editable === "true" || editable === ""
  }
  // What shows of an element, never its hidden text: what a page hides is no name for its controls.
  const shownText = (element: Element) =>
    (("innerText" in element ? property(element, "innerText") : property(element, "textContent")) as string | null) ??
    ""
  const nameOf = (element: Element) => {
    const root = invoke(element, "getRootNode") as Document | ShadowRoot
    const labelled = (attribute(element, "aria-labelledby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => line(root.getElementById?.(id)?.textContent))
      .join(" ")
    const labels = Array.from((element as HTMLInputElement).labels ?? [])
      .map((label) => line(shownText(label)))
      .join(" ")
    const tag = tagOf(element)
    const value =
      tag === "input" && ["button", "submit", "reset"].includes(typeOf(element))
        ? (element as HTMLInputElement).value
        : ""
    return line(
      attribute(element, "aria-label") ||
        labelled ||
        labels ||
        attribute(element, "alt") ||
        attribute(element, "title") ||
        attribute(element, "placeholder") ||
        value ||
        (tag === "input" || tag === "select" || tag === "textarea" ? attribute(element, "name") : "") ||
        shownText(element),
    ).slice(0, 80)
  }
  const form = (element: Element) => {
    if ((attribute(element, "method") ?? "get").toLowerCase() !== "get") return
    const action = String(property(element, "action") || (property(element, "ownerDocument") as Document).URL)
    // An action that does not parse reads back as written, which can still start with http.
    if (!web(action) || !URL.canParse(action)) return
    const address = new URL(action)
    forms.push(`${address.origin}${address.pathname}`)
  }
  const walk = (root: ParentNode, depth: number, main: boolean) => {
    if (depth > 200) return
    Array.from(property(root, "children") as HTMLCollection).forEach((element) => {
      const tag = tagOf(element)
      if (SKIP.has(tag) || !visible(element)) return
      const inside = main || tag === "main" || tag === "article" || attribute(element, "role") === "main"
      if (tag === "form") form(element)
      if (interactive(element) && elements.length < options.maxElements) {
        const ref = `ref_${elements.length + 1}`
        refs.set(ref, element)
        const href = tag === "a" ? (element as HTMLAnchorElement).href : undefined
        const type = typeOf(element)
        elements.push({
          ref,
          role: roleOf(element),
          name: nameOf(element),
          tag,
          ...(type ? { type } : {}),
          ...(href ? { href } : {}),
          ...((element as HTMLButtonElement).disabled ? { disabled: true } : {}),
        })
        if (href) links.push({ url: href, text: nameOf(element), main: inside })
      }
      if (tag === "iframe" || tag === "frame") {
        // Null for a frame of another origin, which no ref reaches.
        const inner = (element as HTMLIFrameElement).contentDocument
        if (inner?.body) walk(inner.body, depth + 1, inside)
        return
      }
      const shadow = property(element, "shadowRoot") as ShadowRoot | null
      if (shadow) walk(shadow, depth + 1, inside)
      walk(element, depth + 1, inside)
    })
  }
  if (top.body) walk(top.body, 0, false)
  return {
    title: line(top.title),
    url: win.location.href,
    text: line(top.body?.innerText).slice(0, options.maxText),
    elements,
    links: links.filter((link, index) => links.findIndex((other) => other.url === link.url) === index),
    forms: [...new Set(forms)],
  }
}

/**
 * Where a click on a ref lands, in the view's coordinates, after scrolling it into view: its centre, and whether the
 * page shows that element there, in its own document and in every frame around it. A file field, or a label for one,
 * is refused, so no file picker opens; a hover, which opens none, is not.
 */
export function clickPoint(win: Window, ref: string, options?: { readonly hover?: boolean }): ClickPoint {
  const refs = (win as unknown as { __vectorRefs?: Map<string, Element> }).__vectorRefs
  const element = refs?.get(ref)
  if (!element || !element.isConnected)
    return { ok: false, reason: `${ref} is gone: the page changed since Vector observed it. Observe the page again.` }
  const file = (node: Element | null | undefined) =>
    node?.localName === "input" && (node.getAttribute("type") ?? "").toLowerCase() === "file"
  const label = element.closest("label") as HTMLLabelElement | null
  if (
    !options?.hover &&
    (file(element) ||
      file(label?.control) ||
      file((element as HTMLLabelElement).control) ||
      Array.from(element.querySelectorAll("input")).some(file))
  )
    return { ok: false, reason: "Vector never opens a file picker in a page, so it did not click that file field." }
  // Instant whatever the page's scroll-behavior says: a smooth scroll would still be moving the element as it is measured.
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" })
  const rect = element.getBoundingClientRect()
  const local = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  // Frames of the page's own origin around the element, innermost first, up to the top document.
  const frames: Element[] = []
  const state = { view: element.ownerDocument.defaultView }
  while (state.view && state.view.frameElement) {
    frames.push(state.view.frameElement)
    state.view = state.view.frameElement.ownerDocument.defaultView
  }
  // Node's own methods, which a form's named fields cannot shadow.
  const call = <T>(node: Node, key: string, ...input: unknown[]) =>
    (Object.getOwnPropertyDescriptor(Node.prototype, key)!.value as (...input: unknown[]) => T).apply(node, input)
  // Whether a document shows `target` at a point: what it finds there, followed into open shadow roots, is the target
  // or inside it, shadow trees included.
  const shows = (owner: Document, target: Element, at: { readonly x: number; readonly y: number }) => {
    const found = { at: owner.elementFromPoint(at.x, at.y) as Node | null }
    while ((found.at as Element | null)?.shadowRoot) {
      const inner = (found.at as Element).shadowRoot!.elementFromPoint(at.x, at.y)
      if (!inner || inner === found.at) break
      found.at = inner
    }
    while (found.at) {
      if (call<boolean>(target, "contains", found.at)) return true
      const root = call<Node>(found.at, "getRootNode")
      found.at = root.nodeType === 11 ? (root as ShadowRoot).host : null
    }
    return false
  }
  // Each frame adds where its document's viewport sits in its parent: its box, its border and its padding. A click
  // there lands on what the parent shows at that point, so whatever covers the frame there takes it.
  const placed = frames.reduce(
    (sum, frame) => {
      const box = frame.getBoundingClientRect()
      const style = (frame.ownerDocument.defaultView ?? win).getComputedStyle(frame)
      const at = {
        x: sum.at.x + box.left + frame.clientLeft + (Number.parseFloat(style.paddingLeft) || 0),
        y: sum.at.y + box.top + frame.clientTop + (Number.parseFloat(style.paddingTop) || 0),
      }
      return { at, hit: sum.hit && shows(frame.ownerDocument, frame, at) }
    },
    { at: local, hit: shows(element.ownerDocument, element, local) },
  )
  const anchor = element.closest("a[href]") as HTMLAnchorElement | null
  return {
    ok: true,
    x: Math.round(placed.at.x),
    y: Math.round(placed.at.y),
    hit: placed.hit,
    ...(anchor && /^https?:\/\//i.test(anchor.href) ? { href: anchor.href } : {}),
  }
}

/** Clicks a ref with the DOM's own click, when trusted input at its centre would land on something else. */
export function clickElement(win: Window, ref: string) {
  const element = (win as unknown as { __vectorRefs?: Map<string, Element> }).__vectorRefs?.get(ref)
  if (!element || !element.isConnected) return false
  ;(element as HTMLElement).click()
  return true
}

/**
 * Focuses a ref for typing, when it is a field research may type into: a text or search field or a text area, never a
 * password, hidden, file, email, tel or payment field, never a field a credential check flags, and never any field of
 * a form that holds a password field. `isCredentialField` is passed in, as browser-credential-field.ts defines it.
 */
export function typeTarget(win: Window, ref: string, isCredentialField: (field: Field) => boolean): Typing {
  const element = (win as unknown as { __vectorRefs?: Map<string, Element> }).__vectorRefs?.get(ref)
  if (!element || !element.isConnected)
    return { ok: false, reason: `${ref} is gone: the page changed since Vector observed it. Observe the page again.` }
  const tag = element.localName
  const type = (element.getAttribute("type") ?? "text").trim().toLowerCase()
  if (tag !== "textarea" && !(tag === "input" && (type === "text" || type === "search" || type === "")))
    return {
      ok: false,
      reason: "Research browsers type only into text fields, search fields and text areas.",
    }
  const describe = (field: Element): Field => ({
    type: field.getAttribute("type"),
    autocomplete: field.getAttribute("autocomplete"),
    name: field.getAttribute("name"),
    id: field.getAttribute("id"),
    textSecurity: (field.ownerDocument.defaultView ?? win)
      .getComputedStyle(field)
      .getPropertyValue("-webkit-text-security"),
  })
  const credential = (field: Element) =>
    isCredentialField(describe(field)) ||
    /(^|\s)(cc-|email|tel|username|webauthn)/.test((field.getAttribute("autocomplete") ?? "").toLowerCase())
  if (credential(element))
    return { ok: false, reason: "Research browsers never type into a sign-in, contact or payment field." }
  const form = (element as HTMLInputElement).form ?? element.closest("form")
  // A form's elements include the fields outside it that join it through their `form` attribute; the ones inside it
  // are read too, in case a page broke the collection. Both through the prototypes: a field named "elements" or
  // "querySelectorAll" shadows the form's own.
  const inherited = (owner: object, key: string): PropertyDescriptor =>
    Object.getOwnPropertyDescriptor(owner, key) ?? inherited(Object.getPrototypeOf(owner), key)
  const fields = form
    ? [
        ...Array.from(
          inherited(Object.getPrototypeOf(form), "elements").get!.call(form) as HTMLFormControlsCollection,
        ).filter((field) => field.localName === "input" || field.localName === "textarea"),
        ...Array.from(
          (inherited(Object.getPrototypeOf(form), "querySelectorAll").value as Element["querySelectorAll"]).call(
            form,
            "input, textarea",
          ),
        ),
      ]
    : []
  if (fields.some((field) => (field.getAttribute("type") ?? "").toLowerCase() === "password" || credential(field)))
    return {
      ok: false,
      reason: "Research browsers never type into a form that asks for a password or other credentials.",
    }
  ;(element as HTMLInputElement).focus()
  ;(element as HTMLInputElement).select?.()
  return { ok: true }
}

/**
 * Whether typing into a ref must stop: focus left it (a page can move focus from any key handler), or what holds
 * focus is a credential field. Checked before every key event. Focus is followed into open shadow roots and into
 * frames, objects and embeds of the page's own origin; one Vector cannot read holds focus somewhere else, so typing
 * stops.
 */
export function typingMoved(win: Window, ref: string, isCredentialField: (field: Field) => boolean) {
  const element = (win as unknown as { __vectorRefs?: Map<string, Element> }).__vectorRefs?.get(ref)
  const state = { active: win.document.activeElement as Element | null }
  while (state.active) {
    const frame = ["iframe", "frame", "object", "embed", "fencedframe"].includes(state.active.localName)
    const inner =
      state.active.shadowRoot?.activeElement ??
      (frame ? (state.active as HTMLIFrameElement).contentDocument?.activeElement : null)
    if (!inner || inner === state.active) break
    state.active = inner
  }
  const active = state.active
  if (!element || !active || active !== element) return true
  return isCredentialField({
    type: active.getAttribute("type"),
    autocomplete: active.getAttribute("autocomplete"),
    name: active.getAttribute("name"),
    id: active.getAttribute("id"),
    textSecurity: (active.ownerDocument.defaultView ?? win)
      .getComputedStyle(active)
      .getPropertyValue("-webkit-text-security"),
  })
}

/**
 * Whether what holds focus is a credential field, for keys sent to whatever has focus (press, and type's trusted
 * keys). Focus is followed into open shadow roots and into what hosts a document of the page's own origin: a frame, an
 * <object> or an <embed>. One Vector cannot read (of another origin, or an embed, which shows none) counts as one: what
 * it focuses inside is unknown, so keys never go there.
 */
export function focusedCredential(win: Window, isCredentialField: (field: Field) => boolean) {
  const state = { active: win.document.activeElement as Element | null, unread: false }
  while (state.active) {
    const frame = ["iframe", "frame", "object", "embed", "fencedframe"].includes(state.active.localName)
    const inner = frame
      ? (state.active as HTMLIFrameElement).contentDocument?.activeElement
      : state.active.shadowRoot?.activeElement
    if (frame && !(state.active as HTMLIFrameElement).contentDocument) state.unread = true
    if (!inner || inner === state.active) break
    state.active = inner
  }
  if (state.unread) return true
  const active = state.active
  if (!active || active === active.ownerDocument.body) return false
  return isCredentialField({
    type: active.getAttribute("type"),
    autocomplete: active.getAttribute("autocomplete"),
    name: active.getAttribute("name"),
    id: active.getAttribute("id"),
    textSecurity: (active.ownerDocument.defaultView ?? win)
      .getComputedStyle(active)
      .getPropertyValue("-webkit-text-security"),
  })
}

/**
 * What Enter or Space would press where focus is, when it could open a file picker: a file field ("file"), or a frame,
 * object or embed Vector cannot read ("frame"), whose focused element is unknown and may be one. Focus is followed into
 * open shadow roots and into documents of the page's own origin, as focusedCredential follows it.
 */
export function focusedFileField(win: Window) {
  const state = { active: win.document.activeElement as Element | null }
  while (state.active) {
    const frame = ["iframe", "frame", "object", "embed", "fencedframe"].includes(state.active.localName)
    if (frame && !(state.active as HTMLIFrameElement).contentDocument) return "frame"
    const inner = frame
      ? (state.active as HTMLIFrameElement).contentDocument?.activeElement
      : state.active.shadowRoot?.activeElement
    if (!inner || inner === state.active) break
    state.active = inner
  }
  if (state.active?.localName === "input" && (state.active.getAttribute("type") ?? "").trim().toLowerCase() === "file")
    return "file"
  return undefined
}

/**
 * The value a ref holds now, or the text an editable element shows, to check what typing put there. An editable
 * element is read as it renders (innerText), where a typed line break is a block of its own.
 */
export function fieldValue(win: Window, ref: string) {
  const element = (win as unknown as { __vectorRefs?: Map<string, Element> }).__vectorRefs?.get(ref)
  if (!element) return undefined
  if ("value" in element) return String((element as HTMLInputElement).value ?? "")
  return (element as HTMLElement).innerText ?? element.textContent ?? ""
}

/**
 * Names the first element a CSS selector matches with the ref `key`, so a command given a selector takes the same path
 * as one given a ref: the same trusted click, the same refusals.
 */
export function bindSelector(win: Window, selector: string, key: string) {
  const element = win.document.querySelector(selector)
  if (!element) return false
  const holder = win as unknown as { __vectorRefs?: Map<string, Element> }
  holder.__vectorRefs = holder.__vectorRefs ?? new Map()
  holder.__vectorRefs.set(key, element)
  return true
}

export type Focus =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly credential?: boolean }

/**
 * Focuses a ref for the visible browser's typing (typeRef, and type, which binds its selector to a ref): a text-like
 * field, a text area or an editable element, never a credential field, a file field, a button or a disabled or
 * read-only field, and selects what it holds, so typing replaces it. `isCredentialField` is passed in, as
 * browser-credential-field.ts defines it; `name` is how the refusals name the target (the ref by default).
 */
export function focusField(
  win: Window,
  ref: string,
  isCredentialField: (field: Field) => boolean,
  name: string = ref,
): Focus {
  const element = (win as unknown as { __vectorRefs?: Map<string, Element> }).__vectorRefs?.get(ref)
  if (!element || !element.isConnected)
    return { ok: false, reason: `${name} is gone: the page changed since Vector observed it. Observe the page again.` }
  const view = element.ownerDocument.defaultView ?? win
  if (
    isCredentialField({
      type: element.getAttribute("type"),
      autocomplete: element.getAttribute("autocomplete"),
      name: element.getAttribute("name"),
      id: element.getAttribute("id"),
      textSecurity: view.getComputedStyle(element).getPropertyValue("-webkit-text-security"),
    })
  )
    return { ok: false, reason: "That is a credential field.", credential: true }
  const tag = element.localName
  const type = (element.getAttribute("type") ?? "text").trim().toLowerCase()
  // A space or a line break typed there would press it, which opens a file picker.
  if (tag === "input" && type === "file")
    return { ok: false, reason: "Vector never opens a file picker in a page, so it did not type into that file field." }
  const editable =
    (element as HTMLElement).isContentEditable === true ||
    ["", "true", "plaintext-only"].includes((element.getAttribute("contenteditable") ?? "false").toLowerCase())
  const field =
    tag === "textarea" || (tag === "input" && ["", "text", "search", "email", "tel", "url", "number"].includes(type))
  if (!editable && !field)
    return {
      ok: false,
      reason: `${name} is no text field: Vector types into text fields, text areas and editable text. Use select_option for a list.`,
    }
  if ((element as HTMLInputElement).disabled || (element as HTMLInputElement).readOnly)
    return { ok: false, reason: `${name} is disabled or read-only, so nothing can be typed into it.` }
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" })
  ;(element as HTMLElement).focus()
  if (field) {
    ;(element as HTMLInputElement).select()
    return { ok: true }
  }
  const range = element.ownerDocument.createRange()
  range.selectNodeContents(element)
  const selection = view.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  return { ok: true }
}

/**
 * Writes a field's whole text at once, for what trusted typing could not put there (a character no key types). A
 * field's value is set and announced with input and change events; this runs apart from the page's own scripts, so a
 * framework's tracking of the value sees a change. An editable element takes the text through the browser's own
 * editing, as typing does, so the editor's model and its DOM stay one. The credential check runs again, after focus,
 * which a page can move.
 */
export function replaceText(
  win: Window,
  ref: string,
  value: string,
  isCredentialField: (field: Field) => boolean,
): Focus {
  const element = (win as unknown as { __vectorRefs?: Map<string, Element> }).__vectorRefs?.get(ref)
  if (!element || !element.isConnected)
    return { ok: false, reason: `${ref} is gone: the page changed since Vector observed it. Observe the page again.` }
  const view = element.ownerDocument.defaultView ?? win
  const credential = () =>
    isCredentialField({
      type: element.getAttribute("type"),
      autocomplete: element.getAttribute("autocomplete"),
      name: element.getAttribute("name"),
      id: element.getAttribute("id"),
      textSecurity: view.getComputedStyle(element).getPropertyValue("-webkit-text-security"),
    })
  if (credential()) return { ok: false, reason: "That is a credential field.", credential: true }
  ;(element as HTMLElement).focus()
  if (credential()) return { ok: false, reason: "That is a credential field.", credential: true }
  if ("value" in element) {
    ;(element as HTMLInputElement).value = value
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }))
    element.dispatchEvent(new Event("change", { bubbles: true }))
    return { ok: true }
  }
  const range = element.ownerDocument.createRange()
  range.selectNodeContents(element)
  const selection = view.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  if (!element.ownerDocument.execCommand("insertText", false, value))
    return { ok: false, reason: "The editor did not take the text." }
  return { ok: true }
}

export type Chosen =
  | { readonly ok: true; readonly labels: readonly string[] }
  | { readonly ok: false; readonly reason: string }

/**
 * Selects options of a `<select>` by value or visible label (several only in a list that takes several), and
 * announces it with input and change events, as the user's choice would.
 */
export function chooseOptions(win: Window, ref: string, values: readonly string[]): Chosen {
  const element = (win as unknown as { __vectorRefs?: Map<string, Element> }).__vectorRefs?.get(ref)
  if (!element || !element.isConnected)
    return { ok: false, reason: `${ref} is gone: the page changed since Vector observed it. Observe the page again.` }
  if (element.localName !== "select")
    return {
      ok: false,
      reason: "select_option chooses in a <select> list only. For a list the page draws itself, click its option.",
    }
  const select = element as HTMLSelectElement
  if (select.disabled) return { ok: false, reason: "That list is disabled, so nothing can be chosen in it." }
  if (values.length === 0) return { ok: false, reason: "Give the option to choose." }
  if (values.length > 1 && !select.multiple) return { ok: false, reason: "That list takes one option at a time." }
  const options = Array.from(select.options)
  const label = (option: HTMLOptionElement) =>
    (option.getAttribute("label") ?? option.textContent ?? "").replace(/\s+/g, " ").trim()
  const chosen = values.map((value) =>
    options.find((option) => !option.disabled && (option.value === value || label(option) === value.trim())),
  )
  const missing = values.find((_, index) => !chosen[index])
  if (missing !== undefined)
    return {
      ok: false,
      reason: `No option of that list is "${missing}". It offers: ${options
        .slice(0, 20)
        .map(label)
        .join(", ")}${options.length > 20 ? ", …" : ""}`,
    }
  const picked = chosen.filter((option): option is HTMLOptionElement => option !== undefined)
  options.forEach((option) => {
    option.selected = picked.includes(option)
  })
  select.dispatchEvent(new Event("input", { bubbles: true }))
  select.dispatchEvent(new Event("change", { bubbles: true }))
  return { ok: true, labels: picked.map(label) }
}
