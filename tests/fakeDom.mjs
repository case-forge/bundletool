/**
 * A small stand-in for the browser's DOM, enough to drive the Review Table's own modules in Node: elements with ids,
 * classes, attributes, data attributes, parents and children, events that bubble to the document, focus, and simple
 * CSS selectors (tag, #id, .class and [attr="value"], joined by spaces as descendants, and lists split by commas).
 * A test builds the elements it needs, or takes the ids from the real template with elementsFromTemplate(). A
 * document made with { parseHtml: true } also builds the elements a script writes with innerHTML (tags, attributes,
 * nesting and plain text; no entities, comments or scripts), for modules such as sections.js that build rows that way.
 */

class FakeClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...names) { for (const n of names) this.set.add(n); }
  remove(...names) { for (const n of names) this.set.delete(n); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : Boolean(force);
    if (on) this.set.add(name); else this.set.delete(name);
    return on;
  }
  toString() { return [...this.set].join(' '); }
}

function parseCompound(text) {
  const m = { tag: null, id: null, classes: [], attrs: [] };
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
  let hit;
  while ((hit = re.exec(text))) {
    if (hit[1]) m.tag = hit[1].toUpperCase();
    else if (hit[2]) m.id = hit[2];
    else if (hit[3]) m.classes.push(hit[3]);
    else m.attrs.push([hit[4], hit[5]]);
  }
  return m;
}

function matchesCompound(el, c) {
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  if (c.classes.some((k) => !el.classList.contains(k))) return false;
  for (const [name, value] of c.attrs) {
    const got = el.getAttribute(name);
    if (got === null) return false;
    if (value !== undefined && got !== value) return false;
  }
  return true;
}

function matchesSelector(el, selector) {
  return selector.split(',').some((one) => {
    const parts = one.trim().split(/\s+/).map(parseCompound);
    if (!matchesCompound(el, parts[parts.length - 1])) return false;
    let at = el.parentElement;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (at && !matchesCompound(at, parts[i])) at = at.parentElement;
      if (!at) return false;
      at = at.parentElement;
    }
    return true;
  });
}

export class FakeElement {
  constructor(doc, tag, id = '') {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.parentElement = null;
    this.children = [];
    this.classList = new FakeClassList(this);
    this.attributes = new Map();
    this.listeners = {};
    this.style = {};
    this.disabled = false;
    this.hidden = false;
    this.textContent = '';
    this.value = '';
    this.placeholder = '';
    this.type = '';
    this.dataset = new Proxy({}, {
      set: (target, key, value) => { target[key] = String(value); return true; },
    });
    if (id) this.id = id;
  }

  get id() { return this.getAttribute('id') ?? ''; }
  set id(value) { this.attributes.set('id', String(value)); }
  get innerHTML() { return this._html ?? ''; }
  set innerHTML(html) {
    this._html = String(html);
    if (!this.ownerDocument.parseHtml) return;
    for (const c of [...this.children]) c.remove();
    buildFromHtml(this.ownerDocument, this, this._html);
  }
  get firstChild() { return this.children[0] ?? null; }
  get previousElementSibling() {
    const kids = this.parentElement?.children ?? [];
    return kids[kids.indexOf(this) - 1] ?? null;
  }
  insertBefore(child, ref) {
    if (!ref) return this.appendChild(child);
    child.remove();
    child.parentElement = this;
    this.children.splice(this.children.indexOf(ref), 0, child);
    return child;
  }
  scrollIntoView() {}
  get className() { return this.classList.toString(); }
  set className(value) { this.classList.set = new Set(String(value).split(/\s+/).filter(Boolean)); }

  setAttribute(name, value) {
    if (name === 'class') { this.className = value; return; }
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    if (name === 'class') return this.className;
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      if (key in this.dataset) return this.dataset[key];
    }
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.getAttribute(name) !== null; }

  appendChild(child) {
    child.remove();
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  append(...children) { for (const c of children) this.appendChild(c); }
  replaceChildren(...children) {
    for (const c of [...this.children]) c.remove();
    this.append(...children);
  }
  removeChild(child) { child.remove(); return child; }
  remove() {
    if (!this.parentElement) return;
    const kids = this.parentElement.children;
    kids.splice(kids.indexOf(this), 1);
    this.parentElement = null;
  }

  matches(selector) { return matchesSelector(this, selector); }
  closest(selector) {
    for (let el = this; el; el = el.parentElement) if (el.matches(selector)) return el;
    return null;
  }
  *descendants() {
    for (const c of this.children) { yield c; yield* c.descendants(); }
  }
  querySelectorAll(selector) { return [...this.descendants()].filter((el) => el.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }

  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  dispatchEvent(event) {
    event.target ??= this;
    for (let el = this; el && !event.stopped; el = el.parentElement) {
      for (const fn of [...(el.listeners[event.type] || [])]) fn.call(el, event);
      // A handler set as a property (button.onclick = ...) runs too, as in a browser.
      if (typeof el[`on${event.type}`] === 'function') el[`on${event.type}`].call(el, event);
    }
    if (!event.stopped) this.ownerDocument.dispatchToDocument(event);
    return !event.defaultPrevented;
  }
  click() {
    if (this.disabled) return;
    this.dispatchEvent(fakeEvent('click'));
  }
  focus() { this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 480, height: 420, right: 480, bottom: 420 }; }
}

/** A canvas whose drawing context is a real one from @napi-rs/canvas when that is installed, else none. */
export class FakeCanvas extends FakeElement {
  constructor(doc, id, makeCanvas) {
    super(doc, 'canvas', id);
    this.real = makeCanvas ? makeCanvas(1, 1) : null;
    this._w = 0;
    this._h = 0;
  }
  get width() { return this._w; }
  set width(v) { this._w = v; if (this.real) this.real.width = Math.max(1, v); }
  get height() { return this._h; }
  set height(v) { this._h = v; if (this.real) this.real.height = Math.max(1, v); }
  getContext(kind, opts) { return this.real ? this.real.getContext(kind, opts) : null; }
}

export function fakeEvent(type, props = {}) {
  return {
    type, defaultPrevented: false, stopped: false, ...props,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
  };
}

const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'source', 'col', 'wbr']);

/** Sets one attribute from markup as the browser would, through the property where the fake DOM keeps one. */
function setFromMarkup(el, name, value) {
  if (name === 'class') el.className = value;
  else if (name === 'value') el.value = value;
  else if (name === 'type') { el.type = value; el.setAttribute('type', value); }
  else if (name === 'placeholder') { el.placeholder = value; el.setAttribute('placeholder', value); }
  else if (name === 'disabled') { el.disabled = true; el.setAttribute('disabled', ''); }
  else if (name.startsWith('data-')) el.dataset[name.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = value;
  else el.setAttribute(name, value);
}

/** Builds the elements of `html` under `parent`: what innerHTML does in a browser, for the markup the page writes. */
function buildFromHtml(doc, parent, html) {
  const stack = [parent];
  const tag = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = tag.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[5] !== undefined) {
      const text = m[5].trim();
      if (text && top !== parent) top.textContent = (top.textContent ? `${top.textContent} ` : '') + text;
      continue;
    }
    const [, closing, name, attrs, selfClosing] = m;
    const lower = name.toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tagName === name.toUpperCase()) { stack.length = i; break; }
      continue;
    }
    const el = new FakeElement(doc, lower);
    for (const a of attrs.matchAll(/([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      setFromMarkup(el, a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? '');
    }
    top.appendChild(el);
    if (!selfClosing && !VOID_TAGS.has(lower)) stack.push(el);
  }
}

export class FakeDocument {
  constructor({ parseHtml = false } = {}) {
    this.parseHtml = parseHtml;
    this.listeners = {};
    this.activeElement = null;
    this.documentElement = new FakeElement(this, 'html');
    this.body = new FakeElement(this, 'body');
    this.documentElement.appendChild(this.body);
  }
  createElement(tag) { return new FakeElement(this, tag); }
  getElementById(id) {
    for (const el of this.documentElement.descendants()) if (el.id === id) return el;
    return null;
  }
  querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); }
  querySelector(selector) { return this.documentElement.querySelector(selector); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  dispatchToDocument(event) {
    for (const fn of [...(this.listeners[event.type] || [])]) fn.call(this, event);
  }
}

/**
 * Builds, under `parent`, one element for every id in a block of the real template (the opening tag's name and its
 * class list are kept), so a module meets the ids the page really has and no others.
 */
export function elementsFromTemplate(doc, parent, html, { makeCanvas } = {}) {
  for (const m of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)\bid="([^"]+)"([^>]*)>/g)) {
    const [, tag, before, id, after] = m;
    const el = tag === 'canvas' ? new FakeCanvas(doc, id, makeCanvas) : new FakeElement(doc, tag, id);
    const cls = /\bclass="([^"]*)"/.exec(before + after)?.[1];
    if (cls) el.className = cls;
    const value = /\bvalue="([^"]*)"/.exec(before + after)?.[1];
    if (value !== undefined) el.value = value;
    if (/\sdisabled\b/.test(before + after)) el.disabled = true;
    parent.appendChild(el);
  }
  return parent;
}

/** The text of one element of the real template, from its opening tag to the end of the block it opens. */
export function templateBlock(html, id) {
  const start = html.indexOf(`id="${id}"`);
  if (start === -1) throw new Error(`template has no #${id}`);
  const open = html.lastIndexOf('<', start);
  const tag = /^<([a-z]+)/.exec(html.slice(open))[1];
  let depth = 0;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g');
  re.lastIndex = open;
  let m;
  while ((m = re.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(open, re.lastIndex);
  }
  throw new Error(`#${id} is not closed`);
}
