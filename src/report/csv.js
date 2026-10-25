import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * The same rows as the workbook, as CSV.
 *
 * No colour — CSV has none. Everything the colour carried is in the `verdict`
 * column and the per-metric numbers, so nothing is lost that a filter cannot
 * recover.
 */

/**
 * Excel evaluates a CSV cell that opens with = + - @ as a formula, so a page
 * title like "=cmd|..." becomes code on someone else's machine. ExcelJS never
 * does this for .xlsx, which is why only this writer needs the guard.
 *
 * A leading apostrophe is the conventional fix and Excel hides it; the tab and
 * carriage-return cases are the same attack with a character Excel strips
 * before deciding.
 */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  // A field containing a quote, comma or newline must be quoted, and inner
  // quotes doubled. Everything else can go through bare.
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export const CSV_COLUMNS = [
  ['url', (r) => r.url],
  ['title', (r) => r.title || ''],
  ['device', (r) => r.device],
  ['score', (r) => r.score],
  ['verdict', (r) => r.verdict],
  ['ttfb_ms', (r) => (r.values || {}).TTFB],
  ['fcp_ms', (r) => (r.values || {}).FCP],
  ['lcp_ms', (r) => (r.values || {}).LCP],
  ['cls', (r) => (r.values || {}).CLS],
  ['tbt_ms', (r) => (r.values || {}).TBT],
  ['speed_index_ms', (r) => (r.values || {}).SI],
  ['size_bytes', (r) => (r.values || {}).BYTES],
  ['status', (r) => r.status || ''],
  ['total_savings_ms', (r) => r.savingsMs],
  // The table puts this behind a details window; a CSV has nowhere to hide it,
  // so every opportunity goes in one cell rather than only the top three.
  ['opportunities', (r) => (r.details || []).map((d) => `${d.title} (${d.ms}ms)`).join(' | ')],
  ['source', (r) => r.sourceGroup || ''],
  ['crux_verdict', (r) => r.cruxVerdict || ''],
  ['tested_at', (r) => r.testedAt || ''],
];

/** Worst score first, the same order the table and the workbook use. */
export function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const sa = a.score === null || a.score === undefined ? -1 : a.score;
    const sb = b.score === null || b.score === undefined ? -1 : b.score;
    return sa - sb || String(a.url).localeCompare(String(b.url));
  });
}

export function toCsv(rows) {
  const lines = [CSV_COLUMNS.map(([h]) => h).join(',')];
  for (const row of sortRows(rows)) {
    lines.push(CSV_COLUMNS.map(([, get]) => csvCell(get(row))).join(','));
  }
  // A BOM, because Excel otherwise reads a UTF-8 CSV as the local codepage and
  // every non-English title arrives as mojibake.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export async function writeCsv(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, toCsv(rows), 'utf8');
  return path;
}
