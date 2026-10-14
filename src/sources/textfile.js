import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

/**
 * One line's worth of URL, or null.
 *
 * A CSV cell is the same problem as a text line with a different separator, so
 * both land here: take the first field that looks like a URL rather than
 * assuming it is the first column, because exports routinely lead with an id.
 */
function urlFromLine(line, csv) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  // Split only for CSV; a plain line may legitimately hold a comma in a query.
  const fields = csv
    ? trimmed.split(',').map((f) => f.trim().replace(/^"(.*)"$/, '$1').trim())
    : [trimmed.split(/\s+/)[0]];          // tolerate "url  some note"

  for (const field of fields) {
    if (!field) continue;
    const candidate = /^https?:\/\//i.test(field) ? field : 'https://' + field;

    // The URL parser happily accepts "https://not", so a bare word from a
    // sentence would slip through as a hostname. Require a real dotted host.
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    const host = parsed.hostname;
    if (host === 'localhost' || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(host)) return candidate;
  }
  return null;
}

/**
 * URLs out of raw text: one per line, or a CSV whose rows carry one somewhere.
 * Blank lines and lines starting with # are ignored, so a list can carry
 * comments, and a bare domain gets https:// so "example.com/page" works.
 */
export function urlsFromText(text, { max = 50, filter = null, csv = false } = {}) {
  const urls = [];
  const seen = new Set();
  const skipped = [];
  let totalMatched = 0;   // everything that qualified, before --max cut it short

  const lines = String(text).split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const url = urlFromLine(line, csv);
    if (!url) {
      // A CSV's first row is usually a header, not a line worth complaining about.
      if (!(csv && i === 0)) skipped.push(line.trim().slice(0, 60));
      continue;
    }

    if (filter && !filter(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    totalMatched++;
    if (max && urls.length >= max) continue;   // keep counting, stop collecting
    urls.push(url);
  }

  return { urls, total: totalMatched, skipped };
}

/** A text or CSV file on disk becomes one group. */
export async function groupFromTextFile(path, { max = 50, filter = null } = {}) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    throw new Error(`Could not read ${path} - ${e.code === 'ENOENT' ? 'it does not exist' : e.message}`);
  }

  const ext = extname(path).toLowerCase();
  const { urls, total, skipped } = urlsFromText(raw, {
    max, filter, csv: ext === '.csv' || ext === '.tsv',
  });

  if (!urls.length) {
    throw new Error(
      `No valid URLs found in ${path}` +
      (filter ? ' (with the filter applied)' : '') +
      (skipped.length ? `. ${skipped.length} line(s) were not URLs, e.g. "${skipped[0]}"` : '')
    );
  }

  const name = basename(path, extname(path)).replace(/[:\\/?*[\]']/g, '-').slice(0, 28) || 'urls';
  return [{ name, source: path, urls, total, skipped: skipped.length }];
}

/**
 * URLs handed over directly — one typed into a box, or a pasted list. Same
 * parsing as a file, so pasting a CSV column behaves the way the file would.
 */
export function groupFromUrls(input, { max = 50, filter = null, name = 'urls' } = {}) {
  // A comma here separates URLs from each other, unlike a comma in a CSV file
  // where it separates a URL from the other columns of the same row. So split
  // on both and let every piece be its own line.
  const text = (Array.isArray(input) ? input.join('\n') : String(input))
    .split(/[\n,]/)
    .join('\n');
  const { urls, total, skipped } = urlsFromText(text, { max, filter });

  if (!urls.length) {
    throw new Error(
      'No valid URLs in what you entered' +
      (filter ? ' (with the filter applied)' : '') +
      (skipped.length ? `. e.g. "${skipped[0]}" is not a URL` : '.')
    );
  }

  // One URL names itself; a list is just "urls".
  const label = urls.length === 1
    ? (new URL(urls[0]).hostname.replace(/^www\./i, '') || name).slice(0, 28)
    : name;
  return [{ name: label, source: `${urls.length} URL(s)`, urls, total, skipped: skipped.length }];
}
