/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * bundletoolRules.js
 * The designs of the rules above and below the cover title: one table that both the PDF drawing (bundletoolCover.js)
 * and the settings picker's samples (bundletoolPage.js) read, so what the picker shows is what the cover prints.
 *
 * A design is a list of strokes laid side by side, outermost first, RULE_SEP points apart. A stroke has a width
 * `w` and, optionally, `dash` (a dash pattern in points; with `round` the dashes have round ends, so a dash of 0 is
 * a dot) or `wave` (it is drawn as a sine wave of that amplitude, wavelength WAVE_LENGTH). The bottom rules are the
 * top ones mirrored, so the title is framed the same above and below.
 */

/** Clear space between two strokes of one design, in points. */
export const RULE_SEP = 2.5;
/** Wavelength of a wave stroke, in points. */
export const WAVE_LENGTH = 9;

/** id, the name a screen reader reads, and the strokes. The first design is the default. */
export const RULE_DESIGNS = [
  { id: 'single', label: 'Single line', strokes: [{ w: 1.5 }] },
  { id: 'double', label: 'Double line', strokes: [{ w: 0.75 }, { w: 0.75 }] },
  { id: 'triple', label: 'Triple line, thick in the middle', strokes: [{ w: 0.5 }, { w: 1.75 }, { w: 0.5 }] },
  { id: 'thick-thin', label: 'Thick then thin line', strokes: [{ w: 1.75 }, { w: 0.5 }] },
  { id: 'thin-thick', label: 'Thin then thick line', strokes: [{ w: 0.5 }, { w: 1.75 }] },
  { id: 'dotted', label: 'Dotted line', strokes: [{ w: 1.5, dash: [0, 3.5], round: true }] },
  { id: 'dashed', label: 'Dashed line', strokes: [{ w: 1, dash: [7, 3.5] }] },
  { id: 'perforated', label: 'Perforated line', strokes: [{ w: 1.1, dash: [1.6, 1.6] }] },
  { id: 'wave', label: 'Wave line', strokes: [{ w: 0.9, wave: 1.6, round: true }] },
];

export const RULE_IDS = RULE_DESIGNS.map((d) => d.id);

export function ruleDesign(id) {
  return RULE_DESIGNS.find((d) => d.id === id) || RULE_DESIGNS[0];
}

/**
 * Where the strokes of a design sit, as the distance of each stroke's centre from the first stroke's centre, going
 * inwards (towards the title). `depth` is how far the design reaches inwards from the first stroke's centre to the
 * edge of the last stroke.
 */
export function strokeLayout(design) {
  const centres = [];
  let c = 0;
  design.strokes.forEach((s, i) => {
    if (i > 0) c += design.strokes[i - 1].w / 2 + RULE_SEP + s.w / 2;
    centres.push(c);
  });
  const last = design.strokes[design.strokes.length - 1];
  return { centres, depth: c + last.w / 2 };
}

/** The points of a wave from x0 to x1 about the line y, step points apart, as [[x, y], ...]. */
export function wavePoints(x0, x1, y, amplitude, step = 1.5) {
  const out = [];
  for (let x = x0; x < x1 + step; x += step) {
    const xx = Math.min(x, x1);
    out.push([xx, y + amplitude * Math.sin(((xx - x0) / WAVE_LENGTH) * 2 * Math.PI)]);
    if (xx === x1) break;
  }
  return out;
}

/**
 * Draws one stroke centred on `y` from x0 to x1 through `page` (a pdf-lib page, or anything with drawLine).
 * Round caps are the pdf-lib value 1.
 */
export function drawStroke(page, stroke, y, x0, x1, color) {
  const cap = stroke.round ? { lineCap: 1 } : {};
  if (stroke.wave) {
    const pts = wavePoints(x0, x1, y, stroke.wave);
    for (let i = 1; i < pts.length; i++) {
      page.drawLine({ start: { x: pts[i - 1][0], y: pts[i - 1][1] }, end: { x: pts[i][0], y: pts[i][1] }, thickness: stroke.w, color, ...cap });
    }
    return;
  }
  page.drawLine({
    start: { x: x0, y },
    end: { x: x1, y },
    thickness: stroke.w,
    color,
    ...(stroke.dash ? { dashArray: stroke.dash, dashPhase: 0 } : {}),
    ...cap,
  });
}

/**
 * The picker's sample of a design as an SVG string (width 120 by 14 points, black on transparent: it takes the
 * page's text colour through `currentColor`). Built from the same table as the PDF.
 */
export function ruleSampleSvg(id) {
  const design = ruleDesign(id);
  const { centres, depth } = strokeLayout(design);
  const W = 120;
  const H = 14;
  const top = (H - depth) / 2 + design.strokes[0].w / 2;
  const parts = design.strokes.map((s, i) => {
    const y = top + centres[i];
    if (s.wave) {
      const d = wavePoints(2, W - 2, y, s.wave, 1).map(([x, yy], k) => `${k ? 'L' : 'M'}${x.toFixed(2)} ${yy.toFixed(2)}`).join('');
      return `<path d="${d}" fill="none" stroke="currentColor" stroke-width="${s.w}" stroke-linecap="round"/>`;
    }
    const dash = s.dash ? ` stroke-dasharray="${s.dash.map((n) => (n === 0 ? 0.01 : n)).join(' ')}"` : '';
    return `<line x1="2" y1="${y}" x2="${W - 2}" y2="${y}" stroke="currentColor" stroke-width="${s.w}"${dash}${s.round ? ' stroke-linecap="round"' : ''}/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true" focusable="false">${parts.join('')}</svg>`;
}
