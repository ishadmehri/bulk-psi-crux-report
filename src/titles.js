import { request } from './http.js';
import { Limiter } from './limiter.js';

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
  '&quot;': '"', '&apos;': "'", '&#39;': "'", '&#039;': "'",
};

function decode(s) {
  return s
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&apos;|&#0?39;/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * Fetch each page's <title>. Unique URLs only — the same page is tested on both
 * devices, and there is no reason to download it twice.
 *
 * A failure here is not worth stopping a run for: the title is a convenience
 * column, so anything that does not come back cleanly is left blank.
 */
export async function fetchTitles(urls, { concurrency = 5, onProgress } = {}) {
  const unique = [...new Set(urls)];
  const limiter = new Limiter({ concurrency });
  const map = new Map();

  await limiter.map(unique, async (url) => {
    const res = await request(url, {
      parse: 'text',
      timeout: 15000,
      retries: 1,
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok || !res.body) { map.set(url, ''); return; }
    const m = String(res.body).match(TITLE_RE);
    map.set(url, m ? decode(m[1]).replace(/\s+/g, ' ').trim().slice(0, 200) : '');
  }, onProgress);

  return map;
}
