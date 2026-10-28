// Small DOM double for behavior tests; not a browser/layout emulator.
export class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.parentElement = null;
    this.ownerDocument = null;
    this.disabled = false;
    this.textContent = "";
    this.dataset = new Proxy({}, {
      get: (_, key) => this.getAttribute("data-" + String(key).replace(/[A-Z]/g, char => "-" + char.toLowerCase())) ?? undefined,
      set: (_, key, value) => {
        this.setAttribute("data-" + String(key).replace(/[A-Z]/g, char => "-" + char.toLowerCase()), value);
        return true;
      }
    });
  }
  get className() { return this.getAttribute("class") || ""; }
  set className(value) { this.setAttribute("class", value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...nodes) {
    for (const node of nodes) { node.remove(); node.parentElement = this; node.ownerDocument ||= this.ownerDocument; this.children.push(node); }
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this);
    this.parentElement = null;
  }
  matches(selector) {
    return selector.split(",").some(part => {
      const s = part.trim(), tag = s.match(/^[a-z]+/i)?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      for (const match of s.matchAll(/\.([\w-]+)/g)) if (!this.className.split(/\s+/).includes(match[1])) return false;
      for (const match of s.matchAll(/\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\]/g)) {
        if (!this.attributes.has(match[1])) return false;
        const expected = match[2] ?? match[3] ?? match[4];
        if (expected !== undefined && this.getAttribute(match[1]) !== expected) return false;
      }
      return true;
    });
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) {
      if (child.matches(selector)) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(name, handler) { this.listeners.set(name, [...(this.listeners.get(name) || []), handler]); }
  removeEventListener(name, handler) { this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== handler)); }
  async emit(name, target = this) {
    const event = { target, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    for (const handler of this.listeners.get(name) || []) await handler(event);
    return event;
  }
  showModal() { this.open = true; }
  close() { this.open = false; }
  reportValidity() { return this.querySelectorAll("input").every(input => !input.required || Boolean(input.value)); }
  click() { if (this.tagName === "A") this.ownerDocument.downloads.push({ href: this.href, filename: this.download }); }
}
export class Document extends Element {
  constructor() {
    super("document");
    this.ownerDocument = this;
    this.downloads = [];
    this.documentElement = new Element("html");
    this.append(this.documentElement);
    this.body = new Element("body");
    this.documentElement.append(this.body);
  }
  createElement(tag) { const node = new Element(tag); node.ownerDocument = this; return node; }
  async click(target) { return this.emit("click", target); }
}
