import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';

import { parseArgs, buildConfig, safeFilePart } from '../src/config.js';
import {
  makeFilter, extractLocs, isIndexDocument, sheetNameFromUrl, uniqueNames, groupsFromChildren,
} from '../src/sources/sitemap.js';
import { groupFromTextFile } from '../src/sources/textfile.js';
import {
  THRESHOLDS, normalise, metricScore, band, overallScore, cwvVerdict, goodMap,
  lighthouseBand, psiVerdict, textSparkline,
} from '../src/score.js';
import { psiReportLink } from '../src/psi.js';
import { writeWorkbook, __test__ as WB } from '../src/report/workbook.js';
import { Limiter } from '../src/limiter.js';

let pass = 0, fail = 0;
const ok = (label, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throws = async (fn, re) => {
  try { await fn(); return false; } catch (e) { return re ? re.test(e.message) : true; }
};

const tmp = mkdtempSync(join(tmpdir(), 'cruxreport-'));

// ---------------------------------------------------------------- fixtures

const SITEMAP_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://e.com/post-sitemap.xml</loc></sitemap>
  <sitemap><loc>https://e.com/page-sitemap.xml</loc></sitemap>
</sitemapindex>`;

const POST_SITEMAP = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://e.com/a</loc></url>
  <url><loc><![CDATA[https://e.com/b?x=1&amp;y=2]]></loc></url>
  <url><loc>https://e.com/a</loc></url>
  <url><loc>https://e.com/c?hl=fr</loc></url>
</urlset>`;

console.log('\n== 1. sitemap parsing ==');
ok('detects a sitemap index', isIndexDocument(SITEMAP_INDEX) === true);
ok('a urlset is not an index', isIndexDocument(POST_SITEMAP) === false);
ok('extracts and dedupes locs', eq(extractLocs(POST_SITEMAP), [
  'https://e.com/a', 'https://e.com/b?x=1&y=2', 'https://e.com/c?hl=fr',
]), extractLocs(POST_SITEMAP));
ok('CDATA + &amp; decoded', extractLocs(POST_SITEMAP)[1] === 'https://e.com/b?x=1&y=2');
ok('limit stops the scan early', extractLocs(POST_SITEMAP, { limit: 2 }).length === 2);
ok('sheet name from url', sheetNameFromUrl('https://e.com/post-sitemap.xml') === 'post-sitemap');
ok('illegal sheet chars stripped', !/[:\\/?*[\]']/.test(sheetNameFromUrl("https://e.com/we:ird'name.xml")),
  sheetNameFromUrl("https://e.com/we:ird'name.xml"));
ok('sheet name capped at 28 chars (Excel limit is 31)',
  sheetNameFromUrl('https://e.com/' + 'x'.repeat(60) + '.xml').length <= 28);

console.log('\n== 2. url filter ==');
ok('no filter -> null', makeFilter(null) === null);
const subFilter = makeFilter('/blog/');
ok('substring filter', subFilter('https://e.com/blog/x') && !subFilter('https://e.com/shop/y'));
const reFilter = makeFilter('/^(?!.*[?&]hl=).*$/');
ok('regex filter drops language variants',
  reFilter('https://e.com/a') && !reFilter('https://e.com/a?hl=fr'));
ok('filter applied inside extractLocs',
  eq(extractLocs(POST_SITEMAP, { filter: reFilter }), ['https://e.com/a', 'https://e.com/b?x=1&y=2']),
  extractLocs(POST_SITEMAP, { filter: reFilter }));
ok('case-insensitive substring', makeFilter('BLOG')('https://e.com/blog/x'));

console.log('\n== 3. groups from an index ==');
const children = [
  { url: 'https://e.com/post-sitemap.xml', name: 'post-sitemap', count: 3, xml: POST_SITEMAP },
  { url: 'https://e.com/page-sitemap.xml', name: 'page-sitemap', count: 1, xml: '<urlset><url><loc>https://e.com/about</loc></url></urlset>' },
];
const groups = groupsFromChildren(children, { max: 2 });
ok('one group per chosen sitemap', groups.length === 2, groups.map((g) => g.name));
ok('max respected per group', groups[0].urls.length === 2, groups[0].urls);
ok('group reports how many were available, so truncation can be surfaced',
  groups[0].total === 3 && groups[0].urls.length === 2, [groups[0].urls.length, groups[0].total]);
ok('max 0 means no cap',
  groupsFromChildren(children, { max: 0 })[0].urls.length === 3,
  groupsFromChildren(children, { max: 0 })[0].urls.length);
ok('group keeps its source url', groups[0].source === 'https://e.com/post-sitemap.xml');
ok('duplicate names get suffixed',
  eq(uniqueNames([{ name: 'x' }, { name: 'x' }, { name: 'x' }]).map((g) => g.name), ['x', 'x-2', 'x-3']));
ok('empty selection throws clearly',
  await throws(() => groupsFromChildren([{ url: 'u', name: 'n', xml: '<urlset></urlset>' }], {}), /No URLs came out/));

console.log('\n== 4. text file source ==');
const txt = join(tmp, 'urls.txt');
writeFileSync(txt, [
  '# a comment',
  'https://e.com/one',
  '',
  'e.com/two',                       // no scheme
  'https://e.com/one',               // duplicate
  'https://e.com/three  some note',  // trailing note
  'not a url at all ###',
].join('\n'), 'utf8');

const fileGroups = await groupFromTextFile(txt, { max: 10 });
ok('reads urls, skips comments and blanks', fileGroups[0].urls.length === 3, fileGroups[0].urls);
ok('adds https to a bare domain', fileGroups[0].urls[1] === 'https://e.com/two', fileGroups[0].urls[1]);
ok('dedupes', new Set(fileGroups[0].urls).size === 3);
ok('takes first token of a line with a note', fileGroups[0].urls[2] === 'https://e.com/three', fileGroups[0].urls[2]);
ok('sheet name from filename', fileGroups[0].name === 'urls', fileGroups[0].name);
ok('max caps the list', (await groupFromTextFile(txt, { max: 2 }))[0].urls.length === 2);
{
  const capped = (await groupFromTextFile(txt, { max: 2 }))[0];
  ok('text file keeps counting past the cap so the total is honest',
    capped.urls.length === 2 && capped.total === 3, [capped.urls.length, capped.total]);
  const uncapped = (await groupFromTextFile(txt, { max: 0 }))[0];
  ok('max 0 on a text file takes everything',
    uncapped.urls.length === 3 && uncapped.total === 3, [uncapped.urls.length, uncapped.total]);
}
ok('filter applies', (await groupFromTextFile(txt, { max: 10, filter: makeFilter('two') }))[0].urls.length === 1);
ok('missing file -> clear error', await throws(() => groupFromTextFile(join(tmp, 'nope.txt'), {}), /does not exist/));
writeFileSync(join(tmp, 'empty.txt'), '# only comments\n\n', 'utf8');
ok('no valid urls -> clear error', await throws(() => groupFromTextFile(join(tmp, 'empty.txt'), {}), /No valid URLs found/));
ok('a sentence is not treated as a url', !fileGroups[0].urls.some((u) => u === 'https://not'), fileGroups[0].urls);
writeFileSync(join(tmp, 'bad.txt'), 'justaword\nanother bare word\n', 'utf8');
ok('bare hostname without a dot rejected',
  await throws(() => groupFromTextFile(join(tmp, 'bad.txt'), {}), /No valid URLs found/));

writeFileSync(join(tmp, 'local.txt'), 'http://localhost:3000/x\n', 'utf8');
ok('localhost is allowed',
  (await groupFromTextFile(join(tmp, 'local.txt'), {}))[0].urls.length === 1);

writeFileSync(join(tmp, 'ip.txt'), 'https://93.184.216.34/page\n', 'utf8');
ok('a bare IP is rejected (CrUX keys on origins, not IPs)',
  await throws(() => groupFromTextFile(join(tmp, 'ip.txt'), {}), /No valid URLs found/));

console.log('\n== 5. scoring ==');
ok('LCP thresholds are the official ones', THRESHOLDS.LCP.good === 2500 && THRESHOLDS.LCP.poor === 4000);
ok('INP thresholds', THRESHOLDS.INP.good === 200 && THRESHOLDS.INP.poor === 500);
ok('CLS thresholds', THRESHOLDS.CLS.good === 0.10 && THRESHOLDS.CLS.poor === 0.25);
ok('weights sum to 100', Object.values(THRESHOLDS).reduce((s, t) => s + t.weight, 0) === 100);
ok('CLS string coerced and rounded to 3dp', normalise('CLS', '0.05123') === 0.051);
ok('ms values rounded to integers', normalise('LCP', 2100.7) === 2101);
ok('null stays null', normalise('LCP', null) === null && normalise('LCP', undefined) === null);
ok('non-numeric -> null', normalise('LCP', 'abc') === null);

ok('good band', band('LCP', 2000) === 'good');
ok('mid band', band('LCP', 3000) === 'mid');
ok('poor band', band('LCP', 5000) === 'poor');
ok('exactly at good threshold counts as good', band('LCP', 2500) === 'good');
ok('exactly at poor threshold is still mid', band('LCP', 4000) === 'mid');
ok('no value -> none', band('LCP', null) === 'none');

ok('perfect metric scores near 100', metricScore('LCP', 0) === 100);
ok('at good threshold scores 90', metricScore('LCP', 2500) === 90);
ok('at poor threshold scores 50', metricScore('LCP', 4000) === 50);
ok('worse than poor scores below 50', metricScore('LCP', 6000) < 50);
ok('never negative', metricScore('LCP', 999999) === 0);

const allGood = { LCP: 1900, INP: 120, CLS: 0.04, FCP: 1100, TTFB: 420 };
const lcpBad = { ...allGood, LCP: 5200 };
ok('all-good verdict is PASS', cwvVerdict(allGood) === 'PASS');
ok('bad LCP -> FAIL', cwvVerdict(lcpBad) === 'FAIL');
ok('FCP/TTFB do not affect the verdict',
  cwvVerdict({ ...allGood, FCP: 9000, TTFB: 9000 }) === 'PASS');
ok('no core data -> NO DATA', cwvVerdict({ FCP: 1000 }) === 'NO DATA');
ok('partial core data still decides', cwvVerdict({ LCP: 1900, INP: null, CLS: null }) === 'PASS');
ok('all-good scores high', overallScore(allGood) >= 90, overallScore(allGood));
ok('bad LCP lowers the score', overallScore(lcpBad) < overallScore(allGood));
ok('missing metrics redistribute weight', overallScore({ LCP: 1000 }) !== null);
ok('nothing at all -> null score', overallScore({}) === null);

const gm = goodMap(lcpBad);
ok('goodMap flags only the bad metric', gm.LCP === false && gm.INP === true && gm.CLS === true, gm);
ok('goodMap keeps null for missing', goodMap({ LCP: 1000 }).INP === null);

console.log('\n== 6. PSI helpers ==');
ok('lighthouse band good', lighthouseBand(0.95) === 'good');
ok('lighthouse band mid', lighthouseBand(0.6) === 'mid');
ok('lighthouse band poor', lighthouseBand(0.2) === 'poor');
ok('lighthouse band none', lighthouseBand(null) === 'none');
ok('psi verdict GOOD at 90', psiVerdict(90) === 'GOOD');
ok('psi verdict NEEDS WORK at 89', psiVerdict(89) === 'NEEDS WORK');
ok('psi verdict POOR at 49', psiVerdict(49) === 'POOR');
ok('psi verdict ERROR for null', psiVerdict(null) === 'ERROR');
const link = psiReportLink('https://e.com/a?x=1&y=2', 'Desktop');
ok('report link encodes the url', link.includes('%3Fx%3D1%26y%3D2'), link);
ok('report link honours device', link.includes('form_factor=desktop') &&
  psiReportLink('https://e.com/a', 'Mobile').includes('form_factor=mobile'));

console.log('\n== 7. text sparkline ==');
ok('rising series ends higher than it starts', (() => {
  const s = textSparkline([1, 2, 3, 4]);
  return s.length === 4 && s[0] === '▁' && s[3] === '█';
})(), textSparkline([1, 2, 3, 4]));
ok('nulls render as blanks', textSparkline([null, 2, 3])[0] === ' ');
ok('flat series does not divide by zero', textSparkline([5, 5, 5]) === '▄▄▄');
ok('fewer than two points -> empty', textSparkline([5]) === '' && textSparkline([null, null]) === '');

console.log('\n== 8. arg parsing and config ==');
ok('--key value form', parseArgs(['--key', 'abc']).key === 'abc');
ok('--key=value form', parseArgs(['--key=abc']).key === 'abc');
ok('boolean flag parsed as true', parseArgs(['--no-trend'])['no-trend'] === true);
ok('flag before another flag stays boolean', parseArgs(['--quiet', '--max', '5']).quiet === true);

const baseArgs = { sitemap: 'https://e.com/s.xml', key: 'K' };
const cfg = buildConfig(baseArgs);
ok('defaults: both devices', eq(cfg.devices, ['Mobile', 'Desktop']), cfg.devices);
ok('defaults: max 50', cfg.max === 50);
ok('defaults: 25 trend weeks', cfg.trendWeeks === 25);
ok('defaults: crux off - PageSpeed is the report', cfg.cruxScope === 'none', cfg.cruxScope);
ok('defaults: no trend without crux', cfg.trend === false);
ok('--crux origin turns the trend back on', buildConfig({ ...baseArgs, crux: 'origin' }).trend === true);
ok('defaults: psi scope all (PageSpeed is the per-page report)', cfg.psiScope === 'all', cfg.psiScope);
ok('--crux pages flips the psi default to failed',
  buildConfig({ ...baseArgs, crux: 'pages' }).psiScope === 'failed');
ok('--crux none keeps the trend off', buildConfig({ ...baseArgs, crux: 'none' }).trend === false);
ok('bad crux scope -> error', await throws(() => buildConfig({ ...baseArgs, crux: 'sometimes' }), /--crux must be/));
ok('psi failed without page-level crux is refused',
  await throws(() => buildConfig({ ...baseArgs, psi: 'failed' }), /--crux pages/));
ok('crux none + psi none is refused',
  await throws(() => buildConfig({ ...baseArgs, crux: 'none', psi: 'none' }), /nothing to report/));
ok('filename says pagespeed when no crux ran', /^pagespeed-/.test(cfg.out), cfg.out);
ok('filename says speed when crux ran',
  /^speed-/.test(buildConfig({ ...baseArgs, crux: 'origin' }).out),
  buildConfig({ ...baseArgs, crux: 'origin' }).out);
ok('output filename carries the site name and a timestamp',
  /^pagespeed-e\.com-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.xlsx$/.test(cfg.out), cfg.out);
ok('www is stripped from the site name',
  buildConfig({ sitemap: 'https://www.example.com/s.xml', key: 'K' }).siteLabel === 'example.com',
  buildConfig({ sitemap: 'https://www.example.com/s.xml', key: 'K' }).siteLabel);
ok('site name for a text file comes from the filename',
  buildConfig({ file: 'C:/tmp/my urls.txt', key: 'K' }).siteLabel === 'my-urls',
  buildConfig({ file: 'C:/tmp/my urls.txt', key: 'K' }).siteLabel);
ok('site name for a sitemap index uses the host',
  buildConfig({ 'sitemap-index': 'https://shop.example.co.uk/sitemap_index.xml', key: 'K' }).siteLabel
    === 'shop.example.co.uk');
ok('filesystem-hostile characters are stripped',
  !/[<>:"/\\|?*]/.test(safeFilePart('a<b>c:d/e\\f|g?h*i')), safeFilePart('a<b>c:d/e\\f|g?h*i'));
ok('--out still wins over the generated name',
  buildConfig({ ...baseArgs, out: 'custom.xlsx' }).out === 'custom.xlsx');
ok('trend-weeks above the API max is rejected',
  await throws(() => buildConfig({ ...baseArgs, 'trend-weeks': '99' }), /1 to 40/));
ok('trend-weeks 40 is allowed', buildConfig({ ...baseArgs, 'trend-weeks': '40' }).trendWeeks === 40);
ok('trend-weeks 0 is rejected, not silently clamped',
  await throws(() => buildConfig({ ...baseArgs, 'trend-weeks': '0' }), /1 to 40/));
ok('--no-trend disables trend even when crux runs',
  buildConfig({ ...baseArgs, crux: 'origin', 'no-trend': true }).trend === false);
ok('single device', eq(buildConfig({ ...baseArgs, devices: 'mobile' }).devices, ['Mobile']));
ok('bare --psi takes the scope-aware default',
  buildConfig({ ...baseArgs, psi: true }).psiScope === 'all' &&
  buildConfig({ ...baseArgs, crux: 'pages', psi: true }).psiScope === 'failed');
ok('psi none is allowed when crux is doing the work',
  buildConfig({ ...baseArgs, crux: 'origin', psi: 'none' }).psiScope === 'none');
ok('no source -> helpful error', await throws(() => buildConfig({ key: 'K' }), /Pick an input source/));
ok('two sources -> error', await throws(
  () => buildConfig({ sitemap: 'a', file: 'b', key: 'K' }), /only one source/));
ok('bad psi scope -> error', await throws(() => buildConfig({ ...baseArgs, psi: 'sometimes' }), /--psi must be/));
ok('bad devices -> error', await throws(() => buildConfig({ ...baseArgs, devices: 'watch' }), /--devices must be/));
ok('missing key -> error naming .env', await throws(() => buildConfig({ sitemap: 'a' }), /CRUX_API_KEY/));
ok('--pick without value means all', buildConfig({ ...baseArgs, pick: true }).pick === 'all');

console.log('\n== 8a. --max accepts a number or "all" ==');
ok('--max all means no cap', buildConfig({ ...baseArgs, max: 'all' }).max === 0);
ok('--max 0 also means no cap', buildConfig({ ...baseArgs, max: '0' }).max === 0);
ok('--max 250 is kept as given', buildConfig({ ...baseArgs, max: '250' }).max === 250);
ok('--max defaults to 50', buildConfig(baseArgs).max === 50);
ok('--max with a non-number errors instead of falling back to the default',
  await throws(() => buildConfig({ ...baseArgs, max: 'lots' }), /--max must be a whole number/));
ok('--max negative is refused', await throws(() => buildConfig({ ...baseArgs, max: '-5' }), /--max must be/));
ok('--max fractional is refused', await throws(() => buildConfig({ ...baseArgs, max: '2.5' }), /--max must be/));

console.log('\n== 8b. mistyped flags must stop the run ==');
// The bug this guards: --device (no s) used to be swallowed, the run continued
// with the default both-devices, and the report silently answered a different
// question than the one that was asked.
ok('--device is rejected, not ignored',
  await throws(() => buildConfig({ ...baseArgs, device: 'mobile' }), /Unknown flag/));
ok('--device suggests --devices',
  await throws(() => buildConfig({ ...baseArgs, device: 'mobile' }), /did you mean --devices/));
ok('a far-off typo still finds its nearest flag',
  await throws(() => buildConfig({ ...baseArgs, consurrency: '5' }), /did you mean --concurrency/));
ok('several unknown flags are all listed at once', await throws(
  () => buildConfig({ ...baseArgs, device: 'mobile', outt: 'a.xlsx' }),
  /--device[\s\S]*--outt/));
ok('nonsense with no close match is still rejected, without a bogus suggestion',
  await throws(() => buildConfig({ ...baseArgs, zzzzzzzzzz: '1' }), /--zzzzzzzzzz\s*\n/));
ok('a value flag given with no value is rejected',
  await throws(() => buildConfig({ ...baseArgs, max: true }), /--max needs a value/));
ok('flags that legitimately work bare are still allowed',
  buildConfig({ ...baseArgs, psi: true }).psiScope === 'all' &&
  buildConfig({ ...baseArgs, crux: true }).cruxScope === 'origin' &&
  buildConfig({ ...baseArgs, pick: true }).pick === 'all');
ok('boolean flags are still allowed bare',
  buildConfig({ ...baseArgs, crux: 'origin', 'no-trend': true }).trend === false &&
  buildConfig({ ...baseArgs, quiet: true }).quiet === true &&
  buildConfig({ ...baseArgs, 'no-origin-fallback': true }).originFallback === false);
ok('every real flag passes the check',
  buildConfig({
    sitemap: 'https://e.com/s.xml', key: 'K', 'psi-key': 'K2', max: '10',
    filter: '/blog/', devices: 'mobile', crux: 'origin', 'trend-weeks': '10',
    out: 'x.xlsx', concurrency: '4', quiet: true, 'no-origin-fallback': true,
  }).devices.length === 1);

console.log('\n== 9. limiter ==');
{
  const lim = new Limiter({ concurrency: 2 });
  let active = 0, peak = 0;
  await lim.map([1, 2, 3, 4, 5, 6], async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
  });
  ok('never exceeds the concurrency cap', peak <= 2, peak);
}
{
  const lim = new Limiter({ concurrency: 5 });
  const out = await lim.map([1, 2, 3, 4], async (n) => {
    await new Promise((r) => setTimeout(r, (5 - n) * 10));
    return n * 10;
  });
  ok('results keep input order despite finishing out of order', eq(out, [10, 20, 30, 40]), out);
}
{
  const lim = new Limiter({ concurrency: 3 });
  let seen = 0;
  await lim.map([1, 2, 3], async () => {}, (done, total) => { seen = done; ok; });
  ok('progress callback reaches the total', seen === 3, seen);
}

console.log('\n== 10. workbook round-trip (writes a real .xlsx and reads it back) ==');
const now = '2026-09-02 15:00 UTC';
const cruxRows = [
  {
    url: 'https://e.com/pass', device: 'Mobile', title: 'Passing page', sourceGroup: 'smoke',
    status: 'OK', score: 96, cwv: 'PASS', checkedAt: now, level: 'page',
    values: { LCP: 1900, INP: 120, CLS: 0.04, FCP: 1100, TTFB: 420 },
    good: { LCP: true, INP: true, CLS: true, FCP: true, TTFB: true },
  },
  {
    url: 'https://e.com/fail?a=1&b=2', device: 'Desktop', title: '=DANGER(1)', sourceGroup: 'smoke',
    status: 'OK', score: 48, cwv: 'FAIL', checkedAt: now, level: 'page',
    values: { LCP: 5200, INP: 140, CLS: 0.06, FCP: 3400, TTFB: 1900 },
    good: { LCP: false, INP: true, CLS: true, FCP: false, TTFB: false },
  },
  {
    url: 'https://e.com/nodata', device: 'Mobile', title: '', sourceGroup: 'smoke',
    status: 'No CrUX field data for this page', score: null, cwv: 'NO DATA', checkedAt: now, level: 'page',
    values: {}, good: {},
  },
];
const trendRows = [
  { url: 'https://e.com/pass', device: 'Mobile', title: 'Passing page', level: 'page', metric: 'LCP',
    points: [3200, 2600, 1900], periodEnds: ['2026-08-16', '2026-08-23', '2026-08-30'] },
  { url: 'https://e.com/fail?a=1&b=2', device: 'Desktop', title: 'x', level: 'origin', metric: 'LCP',
    points: [null, null, 5200], periodEnds: ['2026-08-16', '2026-08-23', '2026-08-30'] },
];
const psiRows = [
  { url: 'https://e.com/fail?a=1&b=2', device: 'Desktop', title: 'x', score: 42, verdict: 'POOR',
    status: 'OK', values: { LCP: 4800, TBT: 611, CLS: 0.051, FCP: 1750, SI: 3400, TTFB: 640 },
    auditScores: { LCP: 0.2, TBT: 0.15, CLS: 0.95, FCP: 0.92, SI: 0.55, TTFB: 0.98 },
    opportunities: 'Reduce unused JavaScript (2340ms)', savingsMs: 3640, lhVersion: '12.0.0',
    testedAt: now, cruxVerdict: 'FAIL', sourceGroup: 'smoke' },
  { url: 'https://e.com/pass', device: 'Mobile', title: 'Passing page', score: 95, verdict: 'GOOD',
    status: 'OK', values: { LCP: 1200, TBT: 40, CLS: 0.01, FCP: 900, SI: 1500, TTFB: 300 },
    auditScores: { LCP: 0.95, TBT: 0.99, CLS: 0.99, FCP: 0.97, SI: 0.9, TTFB: 0.99 },
    opportunities: '', savingsMs: 0, lhVersion: '12.0.0',
    testedAt: now, cruxVerdict: 'PASS', sourceGroup: 'smoke' },
];

const xlsxPath = join(tmp, 'report.xlsx');
await writeWorkbook(xlsxPath, {
  runInfo: {
    siteLabel: "example.com", generatedAt: now, sourceLabel: 'file: urls.txt', devices: ['Mobile', 'Desktop'],
    max: 50, filter: null, trend: true, trendWeeks: 3, cruxScope: 'pages', psiScope: 'failed',
  },
  groups: [{ name: 'smoke', source: 'urls.txt', urls: ['a', 'b', 'c'] }],
  cruxRows, trendRows, psiRows,
  originRows: [
    { origin: 'https://e.com', device: 'Mobile', level: 'origin', cwv: 'FAIL', score: 81,
      values: { LCP: 3414, INP: 139, CLS: 0.01 } },
    { origin: 'https://e.com', device: 'Desktop', level: 'origin', cwv: 'NO DATA', score: null, values: {} },
  ],
});

const back = new ExcelJS.Workbook();
await back.xlsx.readFile(xlsxPath);

const names = back.worksheets.map((w) => w.name);
ok('group sheet holds PageSpeed; page CrUX gets its own sheet',
  eq(names, ['Summary', 'smoke', 'CrUX pages', 'Trend']), names);

const argb = (cell) => cell.fill && cell.fill.fgColor ? cell.fill.fgColor.argb : null;
const sm = back.getWorksheet('CrUX pages');

ok('header text intact', sm.getCell('A1').value === 'PSI test' && sm.getCell('E1').value === 'level' &&
  sm.getCell('G1').value === 'cwv', [sm.getCell('E1').value, sm.getCell('G1').value]);
ok('header is bold on dark', sm.getCell('A1').font.bold === true && argb(sm.getCell('A1')) === WB.FILL.head);
ok('panes frozen at row 1 / col 2',
  sm.views[0].state === 'frozen' && sm.views[0].ySplit === 1 && sm.views[0].xSplit === 2, sm.views[0]);
ok('autofilter covers the header', !!sm.autoFilter);

const rowFor = (needle) => {
  for (let r = 2; r <= sm.rowCount; r++) if (String(sm.getCell(r, 2).value).includes(needle)) return r;
  return -1;
};
const rPass = rowFor('/pass'), rFail = rowFor('/fail'), rNone = rowFor('/nodata');
ok('all three rows written', rPass > 0 && rFail > 0 && rNone > 0, { rPass, rFail, rNone });

ok('PASS row is green across all 13 columns',
  Array.from({ length: 14 }, (_, i) => argb(sm.getCell(rPass, i + 1))).every((c) => c === WB.FILL.good));
ok('NO DATA row is grey',
  [1, 2, 5, 8].every((c) => argb(sm.getCell(rNone, c)) === WB.FILL.none));
ok('FAIL row: url cell red', argb(sm.getCell(rFail, 2)) === WB.FILL.poor);
ok('FAIL row: LCP red (col 7)', argb(sm.getCell(rFail, WB.METRIC_COL.LCP)) === WB.FILL.poor);
ok('FAIL row: INP green (col 8)', argb(sm.getCell(rFail, WB.METRIC_COL.INP)) === WB.FILL.good);
ok('FAIL row: CLS green (col 9)', argb(sm.getCell(rFail, WB.METRIC_COL.CLS)) === WB.FILL.good);
ok('FAIL row: FCP red (col 10)', argb(sm.getCell(rFail, WB.METRIC_COL.FCP)) === WB.FILL.poor);
ok('FAIL row: TTFB red (col 11)', argb(sm.getCell(rFail, WB.METRIC_COL.TTFB)) === WB.FILL.poor);

const linkCell = sm.getCell(rPass, 1);
ok('PSI hyperlink survives the round trip',
  linkCell.value && linkCell.value.hyperlink && linkCell.value.hyperlink.includes('pagespeed.web.dev'),
  linkCell.value);
ok('mobile row links to the mobile report', linkCell.value.hyperlink.includes('form_factor=mobile'));
ok('desktop row links to the desktop report',
  sm.getCell(rFail, 1).value.hyperlink.includes('form_factor=desktop'));
ok('level column written as page', sm.getCell(rPass, 5).value === 'page', sm.getCell(rPass, 5).value);
ok('title starting with = is stored as text, not a formula',
  sm.getCell(rFail, 3).value === '=DANGER(1)' && !sm.getCell(rFail, 3).formula,
  { value: sm.getCell(rFail, 3).value, formula: sm.getCell(rFail, 3).formula });
ok('numbers stored as numbers, not strings',
  typeof sm.getCell(rPass, WB.METRIC_COL.LCP).value === 'number');
ok('missing metrics left empty', sm.getCell(rNone, WB.METRIC_COL.LCP).value === null);

const tr = back.getWorksheet('Trend');
ok('trend headers include the period end dates',
  tr.getCell(1, WB.FIRST_WEEK_COL).value === '2026-08-16' &&
  tr.getCell(1, WB.FIRST_WEEK_COL + 2).value === '2026-08-30',
  [tr.getCell(1, WB.FIRST_WEEK_COL).value, tr.getCell(1, WB.FIRST_WEEK_COL + 2).value]);
ok('trend frozen at 4 columns', tr.views[0].xSplit === 4);

const trendRowFor = (needle) => {
  for (let r = 2; r <= tr.rowCount; r++) if (String(tr.getCell(r, 1).value).includes(needle)) return r;
  return -1;
};
const tImproving = trendRowFor('/pass');
ok('weeks counts only real points', tr.getCell(tImproving, 7).value === 3, tr.getCell(tImproving, 7).value);
ok('trend level column written', tr.getCell(tImproving, 4).value === 'page', tr.getCell(tImproving, 4).value);
ok('oldest / latest', tr.getCell(tImproving, 8).value === 3200 && tr.getCell(tImproving, 9).value === 1900);
ok('change % is negative when improving', tr.getCell(tImproving, 10).value === -40.6,
  tr.getCell(tImproving, 10).value);
ok('improving change cell is green', argb(tr.getCell(tImproving, 10)) === WB.FILL.good);
ok('latest 1900 cell is green', argb(tr.getCell(tImproving, 9)) === WB.FILL.good);
ok('week 3200 is amber', argb(tr.getCell(tImproving, WB.FIRST_WEEK_COL)) === WB.FILL.mid,
  argb(tr.getCell(tImproving, WB.FIRST_WEEK_COL)));
ok('sparkline text written', typeof tr.getCell(tImproving, 6).value === 'string' &&
  tr.getCell(tImproving, 6).value.length === 3, tr.getCell(tImproving, 6).value);

const tNew = trendRowFor('/fail');
ok('new url: weeks = 1', tr.getCell(tNew, 7).value === 1);
ok('origin-level trend row marked as such', tr.getCell(tNew, 4).value === 'origin', tr.getCell(tNew, 4).value);
ok('new url: change % blank, not 0', tr.getCell(tNew, 10).value === null, tr.getCell(tNew, 10).value);
ok('new url: change cell grey', argb(tr.getCell(tNew, 10)) === WB.FILL.none);
ok('leading null weeks are grey',
  argb(tr.getCell(tNew, WB.FIRST_WEEK_COL)) === WB.FILL.none &&
  argb(tr.getCell(tNew, WB.FIRST_WEEK_COL + 1)) === WB.FILL.none);
ok('latest 5200 is red', argb(tr.getCell(tNew, WB.FIRST_WEEK_COL + 2)) === WB.FILL.poor);

const ps = back.getWorksheet('smoke');
ok('PSI header', ps.getCell('E1').value === 'score' && ps.getCell('M1').value === 'status' &&
  ps.getCell('N1').value === 'top opportunities', [ps.getCell('M1').value, ps.getCell('N1').value]);
ok('POOR row: url cell red', argb(ps.getCell(2, 2)) === WB.FILL.poor);
ok('POOR row: LCP cell red (audit 0.2)', argb(ps.getCell(2, 7)) === WB.FILL.poor);
ok('POOR row: CLS cell green despite red row (audit 0.95)', argb(ps.getCell(2, 9)) === WB.FILL.good);
ok('POOR row: Speed Index amber (audit 0.55)', argb(ps.getCell(2, 11)) === WB.FILL.mid);
ok('opportunities text carried', String(ps.getCell(2, 14).value).includes('2340ms'));
ok('psi status column carries the reason', ps.getCell(2, 13).value === 'OK', ps.getCell(2, 13).value);
ok('crux verdict alongside for comparison', ps.getCell(2, 16).value === 'FAIL', ps.getCell(2, 16).value);

const sum = back.getWorksheet('Summary');
const summaryText = [];
sum.eachRow((row) => summaryText.push(row.values.map((v) => (v == null ? '' : String(v))).join('|')));
const summaryBlob = summaryText.join('\n');
ok('summary lists the source', summaryBlob.includes('file: urls.txt'));
ok('summary counts PageSpeed verdicts',
  /GOOD\s+\(90-100\)\|1/.test(summaryBlob) && /POOR\s+\(0-49\)\|1/.test(summaryBlob),
  summaryBlob.slice(0, 500));
ok('summary shows the domain-level real-user line',
  /real users \(whole domain\)/.test(summaryBlob) && /LCP 3414ms/.test(summaryBlob),
  summaryBlob.slice(300, 900));
ok('summary marks a domain that has no data', /no data for this domain/.test(summaryBlob));
ok('summary records the crux scope', /CrUX scope\|pages/.test(summaryBlob));
ok('summary warns lab and field differ', /will not match/.test(summaryBlob));
ok('summary explains what level=origin means', /not a measurement of one page/.test(summaryBlob));
ok('summary counts page-level CrUX rows', /page-level CrUX rows/.test(summaryBlob));

console.log('\n== 11. empty optional sheets ==');
const bare = join(tmp, 'bare.xlsx');
await writeWorkbook(bare, {
  runInfo: { siteLabel: "example.com", generatedAt: now, sourceLabel: 's', devices: ['Mobile'], max: 5, filter: null,
    trend: false, trendWeeks: 25, cruxScope: 'pages', psiScope: 'none' },
  groups: [{ name: 'only', source: 's', urls: ['a'] }],
  cruxRows: [{ ...cruxRows[0], sourceGroup: 'only' }],
  trendRows: [], psiRows: [],
});
const bareWb = new ExcelJS.Workbook();
await bareWb.xlsx.readFile(bare);
ok('no Trend or PSI sheet when unused',
  eq(bareWb.worksheets.map((w) => w.name), ['Summary', 'CrUX pages']),
  bareWb.worksheets.map((w) => w.name));

console.log('\n== 12. combined "All" sheet across multiple sitemaps ==');
// Two groups (as if two sitemaps were picked from a sitemap index), each with
// its own PSI rows — this is the case the merged view exists for.
const multiPsi = [
  { url: 'https://e.com/blog/a', device: 'Mobile', title: 'Blog A', score: 30, verdict: 'POOR',
    status: 'OK', values: { LCP: 9000, TBT: 900, CLS: 0.3, FCP: 3000, SI: 6000, TTFB: 1200 },
    auditScores: { LCP: 0.1, TBT: 0.1, CLS: 0.1, FCP: 0.3, SI: 0.1, TTFB: 0.5 },
    opportunities: '', savingsMs: 0, lhVersion: '12.0.0', testedAt: now,
    cruxVerdict: '', sourceGroup: 'blog-sitemap' },
  { url: 'https://e.com/shop/b', device: 'Mobile', title: 'Shop B', score: 92, verdict: 'GOOD',
    status: 'OK', values: { LCP: 1000, TBT: 30, CLS: 0.01, FCP: 800, SI: 1200, TTFB: 300 },
    auditScores: { LCP: 0.98, TBT: 0.98, CLS: 0.99, FCP: 0.97, SI: 0.95, TTFB: 0.99 },
    opportunities: '', savingsMs: 0, lhVersion: '12.0.0', testedAt: now,
    cruxVerdict: '', sourceGroup: 'shop-sitemap' },
];
const multi = join(tmp, 'multi.xlsx');
await writeWorkbook(multi, {
  runInfo: { siteLabel: 'example.com', generatedAt: now, sourceLabel: 's', devices: ['Mobile'], max: 5,
    filter: null, trend: false, trendWeeks: 25, cruxScope: 'none', psiScope: 'all' },
  groups: [
    { name: 'blog-sitemap', source: 's1', urls: ['a'] },
    { name: 'shop-sitemap', source: 's2', urls: ['b'] },
  ],
  cruxRows: [], trendRows: [], psiRows: multiPsi,
});
const multiWb = new ExcelJS.Workbook();
await multiWb.xlsx.readFile(multi);
const multiNames = multiWb.worksheets.map((w) => w.name);
ok('All sheet appears before the per-group sheets, groups keep their own too',
  eq(multiNames, ['Summary', 'All', 'blog-sitemap', 'shop-sitemap']), multiNames);

const allSheet = multiWb.getWorksheet('All');
ok('All sheet has one row per group\'s pages combined', allSheet.rowCount === 3, allSheet.rowCount);
ok('worst score sorts first on the combined sheet',
  allSheet.getCell(2, 2).value === 'https://e.com/blog/a' && allSheet.getCell(3, 2).value === 'https://e.com/shop/b',
  [allSheet.getCell(2, 2).value, allSheet.getCell(3, 2).value]);
ok('source column on the combined sheet still says which sitemap each row came from',
  allSheet.getCell(2, 17).value === 'blog-sitemap' && allSheet.getCell(3, 17).value === 'shop-sitemap',
  [allSheet.getCell(2, 17).value, allSheet.getCell(3, 17).value]);

const blogSheet = multiWb.getWorksheet('blog-sitemap');
ok('per-group sheet still only has its own rows', blogSheet.rowCount === 2, blogSheet.rowCount);

// A single group must not get a redundant "All" copy of itself.
const single = join(tmp, 'single.xlsx');
await writeWorkbook(single, {
  runInfo: { siteLabel: 'example.com', generatedAt: now, sourceLabel: 's', devices: ['Mobile'], max: 5,
    filter: null, trend: false, trendWeeks: 25, cruxScope: 'none', psiScope: 'all' },
  groups: [{ name: 'blog-sitemap', source: 's1', urls: ['a'] }],
  cruxRows: [], trendRows: [], psiRows: [multiPsi[0]],
});
const singleWb = new ExcelJS.Workbook();
await singleWb.xlsx.readFile(single);
ok('single group gets no "All" tab (it would just duplicate the group sheet)',
  eq(singleWb.worksheets.map((w) => w.name), ['Summary', 'blog-sitemap']),
  singleWb.worksheets.map((w) => w.name));

// A group literally named "All" must not collide with the combined sheet's name.
const collide = join(tmp, 'collide.xlsx');
await writeWorkbook(collide, {
  runInfo: { siteLabel: 'example.com', generatedAt: now, sourceLabel: 's', devices: ['Mobile'], max: 5,
    filter: null, trend: false, trendWeeks: 25, cruxScope: 'none', psiScope: 'all' },
  groups: [
    { name: 'All', source: 's1', urls: ['a'] },
    { name: 'shop-sitemap', source: 's2', urls: ['b'] },
  ],
  cruxRows: [], trendRows: [],
  psiRows: [{ ...multiPsi[0], sourceGroup: 'All' }, multiPsi[1]],
});
const collideWb = new ExcelJS.Workbook();
await collideWb.xlsx.readFile(collide);
ok('combined sheet renamed to avoid colliding with a group literally called "All"',
  collideWb.worksheets.some((w) => w.name === 'All-2'),
  collideWb.worksheets.map((w) => w.name));


// --out reports/weekly.xlsx in a scheduled job: the folder will not exist the
// first time, and failing there after a long run would throw the whole run away.
const nested = join(tmp, 'auto', 'weekly', 'report.xlsx');
await writeWorkbook(nested, {
  runInfo: { siteLabel: 'example.com', generatedAt: now, sourceLabel: 's', devices: ['Mobile'], max: 5,
    filter: null, trend: false, trendWeeks: 25, cruxScope: 'none', psiScope: 'all' },
  groups: [{ name: 'blog-sitemap', source: 's1', urls: ['a'] }],
  cruxRows: [], trendRows: [], psiRows: [multiPsi[0]],
});
ok('--out into a folder that does not exist yet creates it', existsSync(nested));

rmSync(tmp, { recursive: true, force: true });

console.log('\n----------------------------------------');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
