import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sideOfBox, resolveDrop } from '../public/js/frontend/dropPosition.js';

// A row-shaped stand-in: only what resolveDrop reads.
function el(classes = [], extra = {}) {
  const set = new Set(classes);
  const node = {
    classList: { contains: (c) => set.has(c) },
    parentNode: null,
    nextElementSibling: null,
    children: [],
    closest(sel) { return this.map?.[sel] ?? null; },
    getBoundingClientRect() { return { top: this.top ?? 0, height: this.height ?? 40 }; },
    querySelector(sel) { return sel === 'tr.file-row' ? this.firstFile ?? null : null; },
    ...extra,
  };
  return node;
}

function section(rowCount) {
  const tbody = el(['section-tbody']);
  const rows = [];
  for (let i = 0; i < rowCount; i++) {
    const r = el(['file-row'], { top: 100 + i * 40, height: 40 });
    r.parentNode = tbody;
    rows.push(r);
  }
  rows.forEach((r, i) => { r.nextElementSibling = rows[i + 1] ?? null; r.map = { '.section-tbody': tbody, tr: r }; });
  tbody.firstFile = rows[0] ?? null;
  return { tbody, rows };
}

test('the upper half of a row means before it, the lower half after it', () => {
  assert.equal(sideOfBox(100, 40, 101), 'before');
  assert.equal(sideOfBox(100, 40, 119), 'before');
  assert.equal(sideOfBox(100, 40, 121), 'after');
  assert.equal(sideOfBox(100, 40, 139), 'after');
});

test('a drop on a row lands before it or before its next sibling', () => {
  const { tbody, rows } = section(3);
  const upper = resolveDrop(rows[1], 105 + 40);
  assert.equal(upper.side, 'before');
  assert.equal(upper.before, rows[1]);
  assert.equal(upper.tbody, tbody);
  const lower = resolveDrop(rows[1], 175);
  assert.equal(lower.side, 'after');
  assert.equal(lower.before, rows[2]);
});

test('a drop on the last row, lower half, means the end of the section', () => {
  const { rows } = section(2);
  const drop = resolveDrop(rows[1], 175);
  assert.equal(drop.side, 'after');
  assert.equal(drop.before, null);
});

test('a drop on the section heading means the start, on the empty line a replace, elsewhere the end', () => {
  const { tbody, rows } = section(2);
  const header = el(['section-header-row']);
  header.parentNode = tbody;
  header.map = { '.section-tbody': tbody, tr: header };
  const start = resolveDrop(header, 0);
  assert.equal(start.side, 'start');
  assert.equal(start.before, rows[0]);

  const empty = el(['empty-section-placeholder']);
  empty.map = { '.section-tbody': tbody, tr: empty };
  assert.equal(resolveDrop(empty, 0).side, 'replace');

  const gap = el([], { map: { '.section-tbody': tbody, tr: null } });
  const end = resolveDrop(gap, 0);
  assert.equal(end.side, 'end');
  assert.equal(end.before, null);
});

test('a drop outside every section resolves to nothing', () => {
  const outside = el([], { map: {} });
  assert.equal(resolveDrop(outside, 0), null);
  assert.equal(resolveDrop(null, 0), null);
});
