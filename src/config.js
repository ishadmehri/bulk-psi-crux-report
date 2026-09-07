import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/** Minimal .env reader — one dependency less, and this file only ever holds keys. */
export async function loadEnv(path = '.env') {
  if (!existsSync(path)) return;
  const raw = await readFile(path, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const FLAGS = new Set(['help', 'h', 'version', 'no-trend', 'quiet', 'no-origin-fallback']);

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const body = a.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) { out[body.slice(0, eq)] = body.slice(eq + 1); continue; }
    if (FLAGS.has(body)) { out[body] = true; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[body] = true; continue; }
    out[body] = next;
    i++;
  }
  return out;
}

const int = (v, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

/** Strip anything a filesystem would object to, and keep it short. */
export function safeFilePart(s) {
  return String(s)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/**
 * A human name for what was tested, so a folder of reports is readable at a
 * glance instead of being a wall of timestamps.
 */
export function labelFor(source, target) {
  if (source === 'file') {
    const base = String(target).split(/[\\/]/).pop() || 'urls';
    return safeFilePart(base.replace(/\.[^.]+$/, '')) || 'urls';
  }
  try {
    return safeFilePart(new URL(target).hostname.replace(/^www\./i, '')) || 'site';
  } catch {
    return 'site';
  }
}

/**
 * Every flag the tool understands.
 *
 * BOOLEAN take no value. VALUE_OPTIONAL have a sensible meaning on their own
 * (`--psi` alone means the default scope). Everything else must be given a
 * value — `--max` with nothing after it used to be silently accepted and then
 * ignored, which is exactly the kind of typo this table exists to catch.
 */
const BOOLEAN_FLAGS = ['help', 'h', 'version', 'no-trend', 'quiet', 'no-origin-fallback'];
const VALUE_OPTIONAL_FLAGS = ['psi', 'crux', 'pick'];
const VALUE_FLAGS = [
  'sitemap', 'sitemap-index', 'file', 'max', 'filter', 'devices',
  'trend-weeks', 'out', 'concurrency', 'psi-concurrency', 'key', 'psi-key',
];
const ALL_FLAGS = [...BOOLEAN_FLAGS, ...VALUE_OPTIONAL_FLAGS, ...VALUE_FLAGS];

function editDistance(a, b) {
  const rows = a.length, cols = b.length;
  let prev = Array.from({ length: cols + 1 }, (_, j) => j);
  for (let i = 1; i <= rows; i++) {
    const cur = [i];
    for (let j = 1; j <= cols; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[cols];
}

/** Closest known flag, when it is close enough to be worth suggesting. */
function nearestFlag(name) {
  let best = null, bestDistance = Infinity;
  for (const known of ALL_FLAGS) {
    const d = editDistance(name, known);
    if (d < bestDistance) { bestDistance = d; best = known; }
  }
  return bestDistance <= 3 ? best : null;
}

/**
 * A mistyped flag must stop the run. Accepting it silently is worse than
 * failing: the tool goes on with its defaults and hands back a report that
 * looks fine but answers a different question than the one that was asked.
 */
export function checkFlags(args) {
  const given = Object.keys(args).filter((k) => k !== '_');

  const unknown = given.filter((k) => !ALL_FLAGS.includes(k));
  if (unknown.length) {
    const lines = unknown.map((name) => {
      const guess = nearestFlag(name);
      return `  --${name}${guess ? `   did you mean --${guess} ?` : ''}`;
    });
    throw new Error(
      `Unknown flag${unknown.length > 1 ? 's' : ''}:\n${lines.join('\n')}\n` +
      'Run --help to see every option.'
    );
  }

  const missingValue = given.filter((k) => VALUE_FLAGS.includes(k) && args[k] === true);
  if (missingValue.length) {
    throw new Error(
      `${missingValue.map((k) => '--' + k).join(', ')} ` +
      `need${missingValue.length > 1 ? '' : 's'} a value, e.g. --max 50`
    );
  }
}

export function buildConfig(args) {
  checkFlags(args);

  const sources = ['sitemap', 'sitemap-index', 'file'].filter((k) => args[k] && args[k] !== true);
  if (sources.length === 0) {
    throw new Error(
      'Pick an input source:\n' +
      '  --sitemap <url>          a flat sitemap\n' +
      '  --sitemap-index <url>    a sitemap index (listed so you can choose)\n' +
      '  --file <path>            a text file, one URL per line'
    );
  }
  if (sources.length > 1) {
    throw new Error(`Give only one source. You passed: ${sources.map((s) => '--' + s).join(' , ')}`);
  }

  const devicesRaw = String(args.devices || 'mobile,desktop').toLowerCase();
  const devices = [];
  if (devicesRaw.includes('mobile') || devicesRaw.includes('phone')) devices.push('Mobile');
  if (devicesRaw.includes('desktop')) devices.push('Desktop');
  if (!devices.length) throw new Error('--devices must be mobile, desktop, or both.');

  // PageSpeed is the default report because it works on every URL. CrUX is
  // opt-in: worth one call per domain when you want real-user numbers.
  const cruxScope = String(args.crux === true ? 'origin' : (args.crux || 'none')).toLowerCase();
  if (!['none', 'origin', 'pages'].includes(cruxScope)) {
    throw new Error(`--crux must be none, origin or pages - not "${cruxScope}".`);
  }

  // With no per-page CrUX verdict there is nothing for "failed" to mean, so the
  // sensible default there is to test every page.
  const psiDefault = cruxScope === 'pages' ? 'failed' : 'all';
  const psiScope = String(args.psi === true ? psiDefault : (args.psi || psiDefault)).toLowerCase();
  if (!['none', 'failed', 'all'].includes(psiScope)) {
    throw new Error(`--psi must be none, failed or all - not "${psiScope}".`);
  }
  if (psiScope === 'failed' && cruxScope !== 'pages') {
    throw new Error(
      '--psi failed needs a per-page PASS/FAIL verdict, which only --crux pages produces.\n' +
      'Either pass --crux pages, or use --psi all.'
    );
  }
  if (cruxScope === 'none' && psiScope === 'none') {
    throw new Error('You passed --crux none and --psi none - that leaves nothing to report.');
  }

  const apiKey = args.key || process.env.CRUX_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'No API key found. Do one of:\n' +
      '  put CRUX_API_KEY=... in a .env file\n' +
      '  or pass --key <key>'
    );
  }
  const psiKey = args['psi-key'] || process.env.PSI_API_KEY || apiKey;

  // The History API caps at 40 periods, so a bigger number is a mistake worth
  // naming rather than silently clamping. 0 means they wanted --no-trend.
  const trendWeeks = int(args['trend-weeks'], 25);
  if (!Number.isInteger(trendWeeks) || trendWeeks < 1 || trendWeeks > 40) {
    throw new Error(
      `--trend-weeks must be a number from 1 to 40, not "${args['trend-weeks']}". (40 is the CrUX History API's own cap. To skip the trend entirely use --no-trend.)`
    );
  }

  // 0 means "no cap". A default of 50 keeps an accidental run over a 600-URL
  // sitemap index cheap, but there has to be a way to say "all of them".
  const maxRaw = String(args.max ?? '50').trim().toLowerCase();
  const maxUrls = maxRaw === 'all' ? 0 : Number(maxRaw);
  if (!Number.isInteger(maxUrls) || maxUrls < 0) {
    throw new Error(`--max must be a whole number or "all", not "${args.max}".`);
  }

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const source = sources[0];
  const target = args[source];
  const siteLabel = labelFor(source, target);

  return {
    source,
    target,
    siteLabel,
    pick: args.pick === true ? 'all' : (args.pick || null),
    max: maxUrls,
    filter: args.filter && args.filter !== true ? String(args.filter) : null,
    devices,
    cruxScope,
    trend: !args['no-trend'] && cruxScope !== 'none',
    originFallback: !args['no-origin-fallback'],
    trendWeeks,
    psiScope,
    apiKey,
    psiKey,
    out: args.out && args.out !== true ? String(args.out)
      : `${cruxScope === 'none' ? 'pagespeed' : 'speed'}-${siteLabel}-${stamp}.xlsx`,
    concurrency: Math.max(1, int(args.concurrency, 8)),
    // PageSpeed is slow per call rather than quota-bound, so it can run wider
    // than the CrUX calls without going near the 240/min ceiling.
    psiConcurrency: Math.max(1, int(args['psi-concurrency'], 10)),
    quiet: !!args.quiet,
  };
}

export const HELP = `
crux-report - page speed reports into an Excel workbook

  PageSpeed runs by default: it works on every URL whether or not it has traffic.
  CrUX is opt-in with --crux: real-user data, one call per domain.

Usage:
  node index.js --sitemap <url>          [options]
  node index.js --sitemap-index <url>    [options]
  node index.js --file <path.txt>        [options]

Input source (pick one):
  --sitemap <url>        a flat sitemap; every URL in it is tested
  --sitemap-index <url>  a sitemap index; children are listed so you can choose
                         each chosen sitemap becomes its own worksheet
  --file <path>          text file, one URL per line (blank and # lines ignored)

Options:
  --pick <sel>           skip the prompt for a sitemap index: 1,3 or 2-4 or all
  --max <n|all>          cap URLs per group (default 50; "all" for no cap)
  --filter <s>           keep only URLs containing this; /regex/ also accepted
  --devices <list>       mobile, desktop, or both (default both)
  --psi <scope>          none | failed | all       (default all)
  --crux <scope>         none | origin | pages     (default none)
                         origin = one call per domain and device
                         pages  = every URL separately, plus a domain fallback
                                  (only worth it if your pages have real traffic)
  --no-trend             skip the weekly history sheet (needs --crux)
  --trend-weeks <n>      history length, 1 to 40 (default 25)
  --no-origin-fallback   with --crux pages, do not fall back to domain level
  --out <file>           output path; default <kind>-<site>-<timestamp>.xlsx
  --concurrency <n>      parallel CrUX requests (default 8)
  --psi-concurrency <n>  parallel PageSpeed requests (default 10)
  --key <k>              API key; otherwise CRUX_API_KEY from .env
  --psi-key <k>          separate PageSpeed key, if it differs
  --quiet                errors only
  --help                 this help

Examples:
  node index.js --file urls.txt --max 20
  node index.js --sitemap-index https://example.com/sitemap_index.xml --max all
  node index.js --file urls.txt --crux origin
  node index.js --sitemap https://example.com/post-sitemap.xml --filter /blog/
  node index.js --sitemap-index https://example.com/sitemap_index.xml --pick 1-5
  node index.js --sitemap-index https://example.com/sitemap_index.xml --devices mobile

Note: real sitemaps often start with the language variants of one page, so the
first N URLs can all be the same page. Exclude them with a filter, e.g.
  --filter "/^(?!.*[?&]hl=).*$/"
`.trim();
