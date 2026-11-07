/**
 * The cover title's rule picker: a dropdown whose choices are drawn lines, not names. It reads the same design table the
 * cover is drawn from (bundletoolRules.js), so each sample is the line the cover will carry. The chosen id lives in the
 * hidden #config-coverTitleLines input, as the other settings do; the options carry data-group so the page's reset and
 * restore code (setBtnGroup) moves the highlight, and the trigger follows the highlight.
 */
import { RULE_DESIGNS, ruleDesign, ruleSampleSvg } from '../bundletoolRules.js';

export function setup() {
  const root = document.getElementById('rule-picker');
  const input = document.getElementById('config-coverTitleLines');
  if (!root || !input) return;
  const trigger = root.querySelector('.bt-rulepicker-trigger');
  const sample = root.querySelector('.bt-rulepicker-sample');
  const list = root.querySelector('.bt-rulepicker-list');
  if (!trigger || !sample || !list) return;

  list.innerHTML = '';
  for (const design of RULE_DESIGNS) {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'bt-rulepicker-option';
    opt.setAttribute('role', 'option');
    opt.setAttribute('aria-label', design.label);
    opt.title = design.label;
    opt.dataset.group = 'coverTitleLines';
    opt.dataset.value = design.id;
    opt.innerHTML = ruleSampleSvg(design.id);
    list.appendChild(opt);
  }
  const options = [...list.querySelectorAll('.bt-rulepicker-option')];

  const show = () => {
    const id = ruleDesign(input.value).id;
    sample.innerHTML = ruleSampleSvg(id);
    trigger.setAttribute('aria-label', `Title lines: ${ruleDesign(id).label}`);
    for (const o of options) {
      const on = o.dataset.value === id;
      o.classList.toggle('btn-group-active', on);
      o.setAttribute('aria-selected', String(on));
    }
  };
  const setOpen = (open) => {
    list.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    if (open) (options.find((o) => o.classList.contains('btn-group-active')) || options[0]).focus();
  };
  const choose = (opt) => {
    input.value = opt.dataset.value;
    show();
    setOpen(false);
    trigger.focus();
    // A hidden input fires no change event, so persist explicitly, as the other button groups do.
    window.scheduleDefaultsSave?.();
    window.refreshAdvancedState?.();
  };

  trigger.addEventListener('click', () => setOpen(list.hidden));
  options.forEach((o) => o.addEventListener('click', () => choose(o)));
  list.addEventListener('keydown', (e) => {
    const i = options.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); options[Math.min(i + 1, options.length - 1)].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); options[Math.max(i - 1, 0)].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); trigger.focus(); }
  });
  document.addEventListener('click', (e) => { if (!root.contains(e.target)) setOpen(false); });
  // Restore and reset change the highlight without a click; the trigger follows it.
  new MutationObserver(show).observe(list, { attributes: true, attributeFilter: ['class'], subtree: true });
  input.addEventListener('change', show);
  show();
}
