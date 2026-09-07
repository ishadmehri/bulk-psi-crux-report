import { request } from '../http.js';
import { Limiter } from '../limiter.js';

/**
 * Sitemap reading.
 *
 * Deliberately regex-based rather than a real XML parser: sitemaps are a fixed,
 * flat shape, and a 71 MB one from developer.chrome.com parses in ~20 ms this
 * way while a DOM parser would hold the whole tree in memory.
 */

const LOC_RE = /<loc>\s*(?:<!\[CDATA\[)?\s*([\s\S]*?)\s*(?:\]\]>)?\s*<\/loc>/gi;

export const isIndexDocument = (xml) => /<sitemapindex[\s>]/i.test(String(xml));
export const isUrlSetDocument = (xml) => /<urlset[\s>]/i.test(String(xml));

/** Build a matcher from a plain substring or a /regex/flags string. */
export function makeFilter(spec) {
  if (!spec) return null;
  const m = String(spec).match(/^\/(.*)\/([gimsuy]*)$/);
  if (m) {
    const re = new RegExp(m[1], m[2].replace(/g/g, ''));
    return (u) => re.test(u);
  }
  const needle = String(spec).toLowerCase();
  return (u) => u.toLowerCase().includes(needle);
}

/**
 * Extract <loc> values, stopping as soon as `limit` is reached so a huge
 * sitemap does not build a 14,000-entry array we then throw away.
 */
export function extractLocs(xml, { limit = 0, filter = null } = {}) {
  const s = typeof xml === 'string' ? xml : String(xml);
  const re = new RegExp(LOC_RE.source, 'gi');
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(s)) !== null) {
    const value = m[1].trim().replace(/&amp;/g, '&');
    if (!value || seen.has(value)) continue;
    if (filter && !filter(value)) continue;
    seen.add(value);
    out.push(value);
    if (limit && out.length >= limit) break;
  }
  return out;
}

/** How many <loc> entries a document has in total, after filtering. */
export function countLocs(xml, filter = null) {
  return extractLocs(xml, { filter }).length;
}

/** Turn a sitemap URL into a safe, short worksheet name. */
export function sheetNameFromUrl(url) {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop() || 'sitemap';
    const clean = seg.replace(/\.(xml|gz)$/gi, '').replace(/[:\\/?*[\]']/g, '-').trim();
    return (clean || 'sitemap').slice(0, 28);
  } catch {
    return 'sitemap';
  }
}

async function fetchXml(url) {
  const res = await request(url, { parse: 'text', timeout: 60000 });
  if (!res.ok) {
    throw new Error(`Could not read ${url} - ${res.error || 'HTTP ' + res.status}`);
  }
  const body = res.body || '';
  if (/^\x1f\x8b/.test(body)) {
    throw new Error(`${url} is gzipped (.gz), which is not supported. Point at the uncompressed one.`);
  }
  return body;
}

/** Read one sitemap and say what it is. */
export async function readSitemap(url) {
  const xml = await fetchXml(url);
  return { url, xml, isIndex: isIndexDocument(xml) };
}

/**
 * List the children of a sitemap index, with URL counts so the picker can show
 * how big each one is. Counts are unfiltered totals; the filter applies later.
 */
export async function listIndexChildren(indexUrl, { concurrency = 5, onProgress } = {}) {
  const { xml, isIndex } = await readSitemap(indexUrl);
  if (!isIndex) {
    throw new Error(`${indexUrl} is not a sitemap index. Try --sitemap instead.`);
  }
  const childUrls = extractLocs(xml);
  if (!childUrls.length) throw new Error('This sitemap index has no child <loc> entries.');

  const limiter = new Limiter({ concurrency });
  const children = await limiter.map(childUrls, async (childUrl) => {
    try {
      const doc = await fetchXml(childUrl);
      if (isIndexDocument(doc)) {
        return { url: childUrl, name: sheetNameFromUrl(childUrl), count: 0, nested: true, xml: null };
      }
      return { url: childUrl, name: sheetNameFromUrl(childUrl), count: extractLocs(doc).length, xml: doc };
    } catch (e) {
      return { url: childUrl, name: sheetNameFromUrl(childUrl), count: 0, error: e.message, xml: null };
    }
  }, onProgress);

  return children;
}

/** Give every group a unique worksheet name. */
export function uniqueNames(groups) {
  const used = new Set();
  return groups.map((g) => {
    let name = g.name || 'urls';
    let i = 2;
    while (used.has(name.toLowerCase())) {
      name = `${(g.name || 'urls').slice(0, 24)}-${i}`;
      i++;
    }
    used.add(name.toLowerCase());
    return { ...g, name };
  });
}

/** A flat sitemap becomes one group. */
export async function groupFromSitemap(url, { max = 50, filter = null } = {}) {
  const { xml, isIndex } = await readSitemap(url);
  if (isIndex) {
    throw new Error(`${url} is a sitemap index. Use --sitemap-index instead.`);
  }
  const urls = extractLocs(xml, { limit: max, filter });
  if (!urls.length) {
    throw new Error(
      `No URLs found in ${url}${filter ? ' (with the filter applied)' : ''}.`
    );
  }
  // Report the full count too, so a silent truncation can be surfaced.
  const total = max ? countLocs(xml, filter) : urls.length;
  return [{ name: sheetNameFromUrl(url), source: url, urls, total }];
}

/** Chosen children of an index become one group each. */
export function groupsFromChildren(children, { max = 50, filter = null } = {}) {
  const groups = [];
  for (const child of children) {
    if (!child.xml) continue;
    const urls = extractLocs(child.xml, { limit: max, filter });
    if (!urls.length) continue;
    const total = max ? countLocs(child.xml, filter) : urls.length;
    groups.push({ name: child.name, source: child.url, urls, total });
  }
  if (!groups.length) {
    throw new Error(`No URLs came out of the selected sitemaps${filter ? ' (with the filter applied)' : ''}.`);
  }
  return uniqueNames(groups);
}
