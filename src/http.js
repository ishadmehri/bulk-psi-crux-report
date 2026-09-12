/**
 * Thin fetch wrapper: timeout, retry with backoff, and a uniform result shape.
 * Never throws for HTTP status — callers decide what a 404 means.
 */

const UA = 'Mozilla/5.0 (compatible; bulk-psi-crux-report/1.0; +https://github.com/ishadmehri/bulk-psi-crux-report)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The proxy Node was actually told to use. Node only honours these variables
 * when NODE_USE_ENV_PROXY is set, so without it the request went direct and
 * the proxy is not a suspect.
 */
export function activeProxy(env = process.env) {
  if (!env.NODE_USE_ENV_PROXY || env.NODE_USE_ENV_PROXY === '0') return null;
  return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || null;
}

/** Does NO_PROXY exempt this host, meaning the request bypassed the tunnel? */
export function bypassesProxy(hostname, env = process.env) {
  const list = env.NO_PROXY || env.no_proxy || '';
  const host = String(hostname).toLowerCase();
  return list.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean).some((entry) => {
    if (entry === '*') return true;
    const bare = entry.replace(/^\./, '');
    return host === bare || host.endsWith('.' + bare);
  });
}

/** Connection-level failures, as opposed to the server answering with an error. */
const CONNECTION_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH',
  'ENETUNREACH', 'EPIPE', 'EPROTO', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * "fetch failed" on its own sends you to look at the site, which is usually
 * innocent. With a proxy in the environment the browser has its own bypass list
 * and opens the page happily while this request dies in the tunnel — so when a
 * proxy is in play and the socket never connected, name it.
 */
export function describeFetchError(e, url, env = process.env) {
  const cause = (e && e.cause) || {};
  const code = cause.code || (e && e.code);
  const proxy = activeProxy(env);

  let host = '';
  try { host = new URL(url).hostname; } catch { /* keep it empty */ }

  if (proxy && code && CONNECTION_CODES.has(code) && !bypassesProxy(host, env)) {
    return `${code} via the proxy at ${proxy} - NODE_USE_ENV_PROXY is on, so this did not go direct. ` +
      `The site can be fine and still fail here - your browser may not be using this proxy at all. ` +
      (host ? `To reach ${host} directly, add it to NO_PROXY.` : 'Check NO_PROXY.');
  }

  if (code) return cause.message ? `${code} - ${cause.message}` : String(code);
  return String((e && e.message) || e);
}

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
      lastErr = e.name === 'AbortError' ? `timeout after ${timeout}ms` : describeFetchError(e, url);
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
