import { request, apiErrorMessage } from './http.js';
import { CRUX_METRICS, CORE_METRICS, normalise, overallScore, cwvVerdict, goodMap } from './score.js';

const QUERY_URL = 'https://chromeuxreport.googleapis.com/v1/records:queryRecord';
const HISTORY_URL = 'https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord';

const ALL_METRICS = Object.values(CRUX_METRICS);
const CORE_API_METRICS = CORE_METRICS.map((m) => CRUX_METRICS[m]);

const formFactorOf = (device) => (device === 'Desktop' ? 'DESKTOP' : 'PHONE');

/** The origin CrUX aggregates a URL under, e.g. https://example.com */
export function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

/**
 * Current 28-day field data.
 *
 * Pass `url` for page-level data or `origin` for the whole domain. A 404 is
 * normal and means only that there was too little traffic to aggregate — most
 * individual pages of a small site have no page-level data at all, which is
 * what the origin fallback in index.js is for.
 */
export async function fetchCurrent({ url, origin, device, apiKey }) {
  const target = origin ? { origin } : { url };
  const res = await request(`${QUERY_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    json: { ...target, formFactor: formFactorOf(device), metrics: ALL_METRICS },
    timeout: 30000,
  });

  const base = {
    url: url ?? origin,
    device,
    level: origin ? 'origin' : 'page',
    checkedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
  };
  const record = res.body && res.body.record;

  if (!record || !record.metrics) {
    const msg = res.status === 404
      ? (origin ? 'No CrUX data for this domain either' : 'No CrUX field data for this page')
      : apiErrorMessage(res, 'no record returned');
    return { ...base, status: msg.slice(0, 160), score: null, cwv: 'NO DATA', values: {}, good: {} };
  }

  const values = {};
  for (const [key, apiName] of Object.entries(CRUX_METRICS)) {
    const m = record.metrics[apiName];
    values[key] = normalise(key, m && m.percentiles ? m.percentiles.p75 : null);
  }

  return {
    ...base,
    status: origin ? 'OK (domain-level — this page has no data of its own)' : 'OK',
    score: overallScore(values),
    cwv: cwvVerdict(values),
    values,
    good: goodMap(values),
  };
}

/**
 * Weekly history for the three Core Web Vitals.
 *
 * Each point is a 28-day rolling average and points are one week apart, so
 * neighbouring points share three weeks of data. The line is therefore smooth
 * and lagging by design: a change takes about four weeks to fully appear.
 */
export async function fetchHistory({ url, origin, device, apiKey, weeks = 25 }) {
  const target = origin ? { origin } : { url };
  const res = await request(`${HISTORY_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    json: {
      ...target,
      formFactor: formFactorOf(device),
      metrics: CORE_API_METRICS,
      collectionPeriodCount: weeks,
    },
    timeout: 30000,
  });

  const level = origin ? 'origin' : 'page';
  const record = res.body && res.body.record;
  if (!record) {
    return {
      url: url ?? origin, device, level, periodEnds: [], series: {},
      status: res.status === 404 ? 'no history' : apiErrorMessage(res, 'no record'),
    };
  }

  const fmt = (d) => (d ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : '');
  const periodEnds = (record.collectionPeriods || []).map((p) => fmt(p.lastDate));

  const series = {};
  for (const metric of CORE_METRICS) {
    const m = record.metrics && record.metrics[CRUX_METRICS[metric]];
    const p75s = m && m.percentilesTimeseries ? m.percentilesTimeseries.p75s : null;
    series[metric] = Array.isArray(p75s)
      ? p75s.map((v) => (v === null || v === undefined || v === 'NaN' ? null : normalise(metric, v)))
      : [];
  }

  return { url: url ?? origin, device, level, periodEnds, series, status: 'OK' };
}
