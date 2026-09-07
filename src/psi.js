import { request, apiErrorMessage } from './http.js';
import { psiVerdict } from './score.js';

const PSI_URL = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

/** Lab metrics we surface. TBT stands in for INP — a lab run has no real interaction. */
const AUDIT = {
  LCP:  'largest-contentful-paint',
  TBT:  'total-blocking-time',
  CLS:  'cumulative-layout-shift',
  FCP:  'first-contentful-paint',
  SI:   'speed-index',
  TTFB: 'server-response-time',
};

/** Audits that carry an estimated saving — the actionable half of a PSI report. */
const OPPORTUNITIES = [
  'render-blocking-resources', 'unused-javascript', 'unused-css-rules',
  'modern-image-formats', 'uses-optimized-images', 'uses-text-compression',
  'uses-responsive-images', 'unminified-css', 'unminified-javascript',
  'efficient-animated-content', 'duplicated-javascript', 'legacy-javascript',
];

/** Savings below this are noise, not advice. */
const MIN_SAVING_MS = 50;

/**
 * One live Lighthouse run on Google's servers. Slow (seconds to a minute) and
 * variable between runs — two runs of the same page will differ by a few points.
 */
export async function fetchPsi({ url, device, apiKey }) {
  const params = new URLSearchParams({
    url,
    strategy: device === 'Desktop' ? 'desktop' : 'mobile',
    category: 'performance',
    key: apiKey,
  });

  const res = await request(`${PSI_URL}?${params}`, { timeout: 120000, retries: 1 });

  const base = {
    url,
    device,
    strategy: device === 'Desktop' ? 'desktop' : 'mobile',
    testedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
  };

  const lh = res.body && res.body.lighthouseResult;
  const perf = lh && lh.categories && lh.categories.performance;

  // Google caches analyses and serves them from whichever backend answers, so
  // asking twice can hand back a run from minutes ago. Report Lighthouse's own
  // fetchTime rather than the moment we asked, or the sheet dates a measurement
  // that never happened then.
  if (lh && lh.fetchTime) {
    base.testedAt = String(lh.fetchTime).slice(0, 16).replace('T', ' ') + ' UTC';
  }

  if (!lh || !perf) {
    const msg = (lh && lh.runtimeError && lh.runtimeError.message)
      ? lh.runtimeError.message
      : apiErrorMessage(res, 'PSI returned no result');
    return {
      ...base, score: null, verdict: 'ERROR', status: String(msg).slice(0, 200),
      values: {}, auditScores: {}, opportunities: '', savingsMs: null, lhVersion: '',
    };
  }

  const audits = lh.audits || {};
  const values = {};
  const auditScores = {};
  for (const [key, id] of Object.entries(AUDIT)) {
    const a = audits[id];
    const raw = a && a.numericValue;
    values[key] = (raw === null || raw === undefined || !Number.isFinite(Number(raw)))
      ? null
      : (key === 'CLS' ? Number(Number(raw).toFixed(3)) : Math.round(Number(raw)));
    auditScores[key] = (a && typeof a.score === 'number') ? a.score : null;
  }

  const found = [];
  for (const id of OPPORTUNITIES) {
    const a = audits[id];
    if (!a || !a.details) continue;
    const ms = Number(a.details.overallSavingsMs || 0);
    if (!Number.isFinite(ms) || ms < MIN_SAVING_MS) continue;
    found.push({ title: String(a.title || id), ms: Math.round(ms) });
  }
  found.sort((a, b) => b.ms - a.ms);

  const score = Math.round(Number(perf.score) * 100);

  return {
    ...base,
    score,
    verdict: psiVerdict(score),
    status: 'OK',
    values,
    auditScores,
    opportunities: found.slice(0, 3).map((o) => `${o.title} (${o.ms}ms)`).join(' · '),
    savingsMs: found.reduce((sum, o) => sum + o.ms, 0),
    lhVersion: String(lh.lighthouseVersion || ''),
  };
}

/** A link that re-runs the test in the browser. Not a snapshot of this run. */
export function psiReportLink(url, device) {
  const ff = device === 'Desktop' ? 'desktop' : 'mobile';
  return `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(url)}&form_factor=${ff}`;
}
