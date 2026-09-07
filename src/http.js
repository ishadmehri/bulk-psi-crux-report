/**
 * Thin fetch wrapper: timeout, retry with backoff, and a uniform result shape.
 * Never throws for HTTP status — callers decide what a 404 means.
 */

const UA = 'Mozilla/5.0 (compatible; crux-report/1.0; +https://github.com/)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @returns {Promise<{ok: boolean, status: number, body: any, error: string|null}>}
 */
export async function request(url, {
  method = 'GET',
  headers = {},
  json = null,
  timeout = 30000,
  retries = 2,
  parse = 'json',        // 'json' | 'text'
  retryOn = [408, 429, 500, 502, 503, 504],
} = {}) {
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // 1s, 3s, 9s — enough to ride out a rate-limit blip without stalling a run
      await sleep(1000 * Math.pow(3, attempt - 1));
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);

    try {
      const res = await fetch(url, {
        method,
        signal: ac.signal,
        headers: {
          'User-Agent': UA,
          ...(json ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        ...(json ? { body: JSON.stringify(json) } : {}),
      });
      clearTimeout(timer);

      let body = null;
      if (parse === 'text') {
        body = await res.text();
      } else {
        const raw = await res.text();
        try { body = raw ? JSON.parse(raw) : null; }
        catch { body = { _raw: raw.slice(0, 500) }; }
      }

      if (!res.ok && retryOn.includes(res.status) && attempt < retries) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }

      return { ok: res.ok, status: res.status, body, error: null };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e.name === 'AbortError' ? `timeout after ${timeout}ms` : String(e.message || e);
      if (attempt === retries) break;
    }
  }

  return { ok: false, status: 0, body: null, error: lastErr };
}

/** Pull a readable message out of a Google API error body. */
export function apiErrorMessage(result, fallback = 'request failed') {
  if (result.error) return result.error;
  const e = result.body && result.body.error;
  if (e && e.message) return String(e.message);
  if (result.status) return `HTTP ${result.status}`;
  return fallback;
}
