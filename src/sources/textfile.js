import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

/**
 * URLs from a plain text file: one per line. Blank lines and lines starting
 * with # are ignored, so a list can carry comments. A bare domain gets https://
 * so "example.com/page" works without ceremony.
 */
export async function groupFromTextFile(path, { max = 50, filter = null } = {}) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    throw new Error(`Could not read ${path} - ${e.code === 'ENOENT' ? 'it does not exist' : e.message}`);
  }

  const urls = [];
  const seen = new Set();
  const skipped = [];
  let totalMatched = 0;   // everything that qualified, before --max cut it short

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    let url = trimmed.split(/\s+/)[0];          // tolerate "url  some note"
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    // The URL parser happily accepts "https://not", so a bare word from a
    // sentence would slip through as a hostname. Require a real dotted host.
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      skipped.push(trimmed.slice(0, 60));
      continue;
    }
    const host = parsed.hostname;
    const plausible = host === 'localhost' || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(host);
    if (!plausible) {
      skipped.push(trimmed.slice(0, 60));
      continue;
    }

    if (filter && !filter(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    totalMatched++;
    if (max && urls.length >= max) continue;   // keep counting, stop collecting
    urls.push(url);
  }

  if (!urls.length) {
    throw new Error(
      `No valid URLs found in ${path}` +
      (filter ? ' (with the filter applied)' : '') +
      (skipped.length ? `. ${skipped.length} line(s) were not URLs, e.g. "${skipped[0]}"` : '')
    );
  }

  const name = basename(path, extname(path)).replace(/[:\\/?*[\]']/g, '-').slice(0, 28) || 'urls';
  return [{ name, source: path, urls, total: totalMatched, skipped: skipped.length }];
}
