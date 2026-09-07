/**
 * Google's official Core Web Vitals thresholds (measured at p75) plus the
 * weights this tool uses to synthesise a 0-100 score.
 *
 * CrUX itself has no overall score — that number people know from PageSpeed is
 * Lighthouse's, computed from lab metrics. This score is a different thing:
 * a weighted roll-up of real-user p75 values. It will not match PageSpeed and
 * is not supposed to.
 */
export const THRESHOLDS = {
  LCP:  { good: 2500, poor: 4000, weight: 30, unit: 'ms' },
  INP:  { good: 200,  poor: 500,  weight: 30, unit: 'ms' },
  CLS:  { good: 0.10, poor: 0.25, weight: 25, unit: '' },
  FCP:  { good: 1800, poor: 3000, weight: 10, unit: 'ms' },
  TTFB: { good: 800,  poor: 1800, weight: 5,  unit: 'ms' },
};

/** CrUX API metric names, in the order we ask for them. */
export const CRUX_METRICS = {
  LCP:  'largest_contentful_paint',
  INP:  'interaction_to_next_paint',
  CLS:  'cumulative_layout_shift',
  FCP:  'first_contentful_paint',
  TTFB: 'experimental_time_to_first_byte',
};

/** The three that decide the official pass/fail. */
export const CORE_METRICS = ['LCP', 'INP', 'CLS'];

/** Round the way each metric is normally read. */
export function normalise(metric, value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return metric === 'CLS' ? Number(n.toFixed(3)) : Math.round(n);
}

/** Per-metric 0-100, piecewise linear across the good / needs-work / poor bands. */
export function metricScore(metric, value) {
  if (value === null || value === undefined) return null;
  const t = THRESHOLDS[metric];
  if (!t) return null;
  if (value <= t.good) return 90 + 10 * (1 - value / t.good);              // 90..100
  if (value <= t.poor) return 50 + 40 * (t.poor - value) / (t.poor - t.good); // 50..90
  return Math.max(0, 50 * (1 - (value - t.poor) / t.poor));                // 0..50
}

/** good / needs-improvement / poor, for cell colouring. */
export function band(metric, value) {
  if (value === null || value === undefined) return 'none';
  const t = THRESHOLDS[metric];
  if (!t) return 'none';
  if (value <= t.good) return 'good';
  if (value > t.poor) return 'poor';
  return 'mid';
}

/**
 * Roll the per-metric scores into one number. Metrics with no data drop out and
 * their weight is redistributed, so a page missing INP is not punished for it.
 */
export function overallScore(values) {
  let weighted = 0, total = 0;
  for (const metric of Object.keys(THRESHOLDS)) {
    const s = metricScore(metric, values[metric]);
    if (s === null) continue;
    weighted += s * THRESHOLDS[metric].weight;
    total += THRESHOLDS[metric].weight;
  }
  return total ? Math.round(weighted / total) : null;
}

/**
 * The official verdict: PASS only when LCP, INP and CLS are all good.
 * Metrics with no data are skipped; if none of the three have data, NO DATA.
 */
export function cwvVerdict(values) {
  const present = CORE_METRICS.filter((m) => values[m] !== null && values[m] !== undefined);
  if (!present.length) return 'NO DATA';
  return present.every((m) => band(m, values[m]) === 'good') ? 'PASS' : 'FAIL';
}

/** Which metrics are individually within standard — drives per-cell green. */
export function goodMap(values) {
  const out = {};
  for (const metric of Object.keys(THRESHOLDS)) {
    const v = values[metric];
    out[metric] = (v === null || v === undefined) ? null : band(metric, v) === 'good';
  }
  return out;
}

/** Lighthouse's own 0-1 audit score mapped to the same three bands. */
export function lighthouseBand(score) {
  if (score === null || score === undefined) return 'none';
  if (score >= 0.9) return 'good';
  if (score >= 0.5) return 'mid';
  return 'poor';
}

/** PSI overall verdict from the 0-100 performance score. */
export function psiVerdict(score) {
  if (score === null || score === undefined) return 'ERROR';
  if (score >= 90) return 'GOOD';
  if (score >= 50) return 'NEEDS WORK';
  return 'POOR';
}

/**
 * A text sparkline from block characters. Excel has real sparklines but no
 * library writes them, and a text one survives copy-paste and CSV export.
 */
const BLOCKS = '▁▂▃▄▅▆▇█';
export function textSparkline(points) {
  const real = points.filter((p) => p !== null && p !== undefined);
  if (real.length < 2) return '';
  const min = Math.min(...real);
  const max = Math.max(...real);
  const span = max - min;
  return points.map((p) => {
    if (p === null || p === undefined) return ' ';
    if (span === 0) return BLOCKS[3];
    const idx = Math.round(((p - min) / span) * (BLOCKS.length - 1));
    return BLOCKS[idx];
  }).join('');
}
