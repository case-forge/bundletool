/**
 * Whether an element of the fake DOM (tests/fakeDom.mjs) is displayed, by the page's own stylesheet's display rules:
 * enough of the cascade to tell when a rule hides an element and when another overrides it. A class name test cannot
 * see that bundletool.css keeps Tailwind's `.hidden{display:none}` inside a cascade layer, so any unlayered rule that
 * sets display (`.bt-rotate-controls{display:flex}`) wins over it, whatever the order: an element carrying both is
 * shown with `hidden` on it.
 *
 * Read: rules inside @layer blocks (layered) and outside them (unlayered); rules inside any other at-rule (@media,
 * @supports, @keyframes, @font-face) are left out. Only selectors the fake DOM can match are kept (tag, #id, .class,
 * [attr], joined by spaces). The winner for an element: !important first, then unlayered over layered, then the higher
 * specificity, then the later rule.
 */

/** The index just past the brace that closes the block opening at `open`, skipping strings and nested blocks. */
function blockEnd(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      i = text.indexOf(c, i + 1);
      if (i === -1) return text.length;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return text.length;
}

/** Every display declaration in `css`, as { selector, display, important, layered, specificity, order }. */
export function displayRules(css) {
  const rules = [];
  let order = 0;
  const walk = (text, layered) => {
    let i = 0;
    while (i < text.length) {
      if (/[\s}]/.test(text[i])) { i++; continue; }
      const open = text.indexOf('{', i);
      const semi = text.indexOf(';', i);
      if (text[i] === '@' && semi !== -1 && (open === -1 || semi < open)) { i = semi + 1; continue; }   // @layer a, b;
      if (open === -1) break;
      const end = blockEnd(text, open);
      const head = text.slice(i, open).trim();
      const body = text.slice(open + 1, end - 1);
      i = end;
      if (head.startsWith('@')) {
        if (/^@layer\b/.test(head)) walk(body, true);   // any other at-rule (@media, @supports, @font-face) is left out
        continue;
      }
      // Only the block's own declarations: a nested block inside it is not this selector's.
      let own = '';
      for (let j = 0; j < body.length;) {
        const nested = body.indexOf('{', j);
        if (nested === -1) { own += body.slice(j); break; }
        own += body.slice(j, body.lastIndexOf(';', nested) + 1);
        j = blockEnd(body, nested);
      }
      const m = /(?:^|;)\s*display\s*:\s*([^;!]+?)\s*(!important)?\s*(?:;|$)/.exec(own);
      if (!m) continue;
      for (const one of head.split(',').map((x) => x.trim())) {
        if (!/^[\w\s.#\-[\]="]+$/.test(one)) continue;
        const ids = (one.match(/#[\w-]+/g) || []).length;
        const classes = (one.match(/\.[\w-]+|\[[^\]]+\]/g) || []).length;
        const tags = (one.replace(/[#.][\w-]+|\[[^\]]+\]/g, ' ').match(/[a-zA-Z][\w-]*/g) || []).length;
        rules.push({ selector: one, display: m[1], important: Boolean(m[2]), layered, specificity: [ids, classes, tags], order: order++ });
      }
    }
  };
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ''), false);
  return rules;
}

const before = (a, b) => {
  if (a.important !== b.important) return a.important ? 1 : -1;
  if (a.layered !== b.layered) return a.layered ? -1 : 1;
  for (let k = 0; k < 3; k++) if (a.specificity[k] !== b.specificity[k]) return a.specificity[k] - b.specificity[k];
  return a.order - b.order;
};

/** The display one element gets from the rules, or null when no rule sets it. */
export function displayOf(el, rules) {
  const hits = rules.filter((r) => el.matches(r.selector));
  if (!hits.length) return null;
  return hits.sort(before)[hits.length - 1].display;
}

/** True when neither the element nor any element round it is display: none. */
export function isDisplayed(el, rules) {
  for (let at = el; at; at = at.parentElement) if (displayOf(at, rules) === 'none') return false;
  return true;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** The elements that hold the element with `id` in the template text `html`, outermost first and ending with it, as
 * { tag, id, className }; null when there is none. */
export function ancestry(html, id) {
  const stack = [];
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const [, closing, tag, attrs] = m;
    const t = tag.toLowerCase();
    if (closing) {
      for (let k = stack.length - 1; k >= 0; k--) if (stack[k].tag === t) { stack.length = k; break; }
      continue;
    }
    const node = { tag: t, id: /\bid="([^"]*)"/.exec(attrs)?.[1] ?? null, className: /\bclass="([^"]*)"/.exec(attrs)?.[1] ?? '' };
    if (node.id === id) return [...stack, node];
    if (!VOID.has(t) && !attrs.trim().endsWith('/')) stack.push(node);
  }
  return null;
}

/**
 * Whether the element with `id` is displayed where the template puts it: it and every element that holds it, each with
 * its classes as they stand in the fake document now when it has an id there (the classes the code has toggled), and
 * the template's own classes otherwise. The fake document holds the template's elements side by side, not nested, so
 * the nesting comes from the template.
 *
 * @param {(tag: string) => object} make - makes a detached fake element (new FakeElement(doc, tag))
 */
export function shownInTemplate(doc, html, id, rules, make) {
  const chain = ancestry(html, id);
  if (!chain) throw new Error(`the template has no #${id}`);
  let leaf = null;
  for (const node of chain) {
    const el = make(node.tag);
    if (node.id) el.setAttribute('id', node.id);
    const live = node.id ? doc.getElementById(node.id) : null;
    el.className = live ? live.className : node.className;
    leaf?.appendChild(el);
    leaf = el;
  }
  return isDisplayed(leaf, rules);
}
