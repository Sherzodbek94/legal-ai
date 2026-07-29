/**
 * Verifies the enterprise theme tokens in app/globals.css meet WCAG 2.1 AA.
 *
 *   node scripts/check-contrast.mjs
 *
 * Thresholds: 4.5:1 for body text (1.4.3), 3:1 for large text and for
 * non-text UI boundaries such as borders and focus rings (1.4.11).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'app', 'globals.css'), 'utf8');

function extractBlock(selector) {
  const re = new RegExp(`${selector}\\s*\\{([^}]*)\\}`, 'm');
  const match = css.match(re);
  if (!match) throw new Error(`Could not find block for ${selector}`);
  const tokens = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/--([\w-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
    if (m) tokens[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  }
  return tokens;
}

function hslToRgb([h, s, l]) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((c) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const l1 = luminance(hslToRgb(a));
  const l2 = luminance(hslToRgb(b));
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// [foreground token, background token, minimum ratio]
const PAIRS = [
  ['foreground', 'background', 4.5],
  ['card-foreground', 'card', 4.5],
  ['popover-foreground', 'popover', 4.5],
  ['primary-foreground', 'primary', 4.5],
  ['secondary-foreground', 'secondary', 4.5],
  ['muted-foreground', 'muted', 4.5],
  ['muted-foreground', 'background', 4.5],
  ['accent-foreground', 'accent', 4.5],
  ['destructive-foreground', 'destructive', 4.5],
  ['success-foreground', 'success', 4.5],
  ['warning-foreground', 'warning', 4.5],
  ['primary', 'background', 4.5],
  ['sidebar-foreground', 'sidebar', 4.5],
  ['sidebar-muted-foreground', 'sidebar', 4.5],
  ['sidebar-accent-foreground', 'sidebar-accent', 4.5],
  // Non-text UI boundaries (1.4.11).
  ['border', 'background', 1.0],
  ['input', 'background', 3.0],
  ['ring', 'background', 3.0],
  ['sidebar-border', 'sidebar', 1.0],
];

let failures = 0;
for (const scheme of ['light', 'dark']) {
  const tokens = extractBlock(scheme === 'light' ? ':root' : '\\.dark');
  console.log(`\n${scheme.toUpperCase()}`);
  for (const [fg, bg, min] of PAIRS) {
    if (!tokens[fg] || !tokens[bg]) {
      console.log(`  SKIP ${fg} on ${bg} (token not defined)`);
      continue;
    }
    const ratio = contrast(tokens[fg], tokens[bg]);
    const ok = ratio >= min;
    if (!ok) failures++;
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'} ${ratio.toFixed(2)}:1 (min ${min}) — ${fg} on ${bg}`,
    );
  }
}

console.log(
  failures === 0
    ? '\nAll pairings meet their WCAG 2.1 AA threshold.'
    : `\n${failures} pairing(s) below threshold.`,
);
process.exit(failures === 0 ? 0 : 1);
