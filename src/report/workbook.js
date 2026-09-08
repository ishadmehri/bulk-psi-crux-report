import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import ExcelJS from 'exceljs';
import { band, lighthouseBand, textSparkline } from '../score.js';
import { psiReportLink } from '../psi.js';

/** Same palette as the Sheets version, as ARGB. */
const FILL = {
  good: 'FFD9EAD3',
  mid:  'FFFFF2CC',
  poor: 'FFF4CCCC',
  none: 'FFEEEEEE',
  head: 'FF2A3340',
  plain: 'FFFFFFFF',
};

const fill = (key) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[key] } });
const LINK_FONT = { color: { argb: 'FF1155CC' }, underline: true };

function styleHeader(sheet, colCount) {
  const row = sheet.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.alignment = { vertical: 'middle', horizontal: 'center' };
  row.height = 22;
  for (let c = 1; c <= colCount; c++) row.getCell(c).fill = fill('head');
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: colCount } };
}

function paint(sheet, rowIdx, colCount, keyFor) {
  const row = sheet.getRow(rowIdx);
  for (let c = 1; c <= colCount; c++) row.getCell(c).fill = fill(keyFor(c));
}

// ---------------------------------------------------------------- CrUX sheets

const CRUX_COLUMNS = [
  { header: 'PSI test',   width: 12 },
  { header: 'url',        width: 52 },
  { header: 'pagetitle',  width: 40 },
  { header: 'device',     width: 10 },
  { header: 'level',      width: 9 },
  { header: 'score',      width: 8 },
  { header: 'cwv',        width: 10 },
  { header: 'LCP (ms)',   width: 11 },
  { header: 'INP (ms)',   width: 11 },
  { header: 'CLS',        width: 9 },
  { header: 'FCP (ms)',   width: 11 },
  { header: 'TTFB (ms)',  width: 11 },
  { header: 'status',     width: 44 },
  { header: 'checked at', width: 19 },
];

/** Column index (1-based) of each metric, for per-cell colouring. */
const METRIC_COL = { LCP: 8, INP: 9, CLS: 10, FCP: 11, TTFB: 12 };
const COL_METRIC = Object.fromEntries(Object.entries(METRIC_COL).map(([k, v]) => [v, k]));

function addCruxSheet(wb, group, rows) {
  const sheet = wb.addWorksheet(group.name, { views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] });
  sheet.columns = CRUX_COLUMNS.map((c) => ({ header: c.header, width: c.width }));
  styleHeader(sheet, CRUX_COLUMNS.length);

  const sorted = [...rows].sort((a, b) => a.url.localeCompare(b.url) || a.device.localeCompare(b.device));

  sorted.forEach((r, i) => {
    const v = r.values || {};
    const row = sheet.addRow([
      'live test', r.url, r.title || '', r.device, r.level || 'page', r.score, r.cwv,
      v.LCP ?? null, v.INP ?? null, v.CLS ?? null, v.FCP ?? null, v.TTFB ?? null,
      r.status, r.checkedAt,
    ]);
    // Domain-level numbers repeat across every page of that site. Italic + grey
    // marks them so nobody reads them as a measurement of this one page.
    if (r.level === 'origin') row.getCell(5).font = { italic: true, color: { argb: 'FF7A6A00' } };

    const link = row.getCell(1);
    link.value = { text: 'live test', hyperlink: psiReportLink(r.url, r.device) };
    link.font = LINK_FONT;

    // PASS: whole row green. FAIL: whole row red, except metric cells that are
    // individually within standard. NO DATA: grey.
    paint(sheet, i + 2, CRUX_COLUMNS.length, (col) => {
      if (r.cwv === 'PASS') return 'good';
      if (r.cwv === 'NO DATA') return 'none';
      const metric = COL_METRIC[col];
      if (metric && r.good && r.good[metric] === true) return 'good';
      return 'poor';
    });
  });

  return sheet;
}

// --------------------------------------------------------------- Trend sheet

const TREND_HEAD = ['url', 'pagetitle', 'device', 'level', 'metric', 'trend', 'weeks', 'oldest', 'latest', 'change %'];
const FIRST_WEEK_COL = TREND_HEAD.length + 1;   // 1-based

function addTrendSheet(wb, trendRows) {
  if (!trendRows.length) return null;

  let periodEnds = [];
  for (const t of trendRows) if (t.periodEnds.length > periodEnds.length) periodEnds = t.periodEnds;
  const weekCount = Math.max(periodEnds.length, 1);

  const sheet = wb.addWorksheet('Trend', { views: [{ state: 'frozen', xSplit: 4, ySplit: 1 }] });
  sheet.columns = [
    { header: 'url', width: 52 },
    { header: 'pagetitle', width: 34 },
    { header: 'device', width: 10 },
    { header: 'level', width: 9 },
    { header: 'metric', width: 9 },
    { header: 'trend', width: Math.max(12, weekCount + 2) },
    { header: 'weeks', width: 8 },
    { header: 'oldest', width: 10 },
    { header: 'latest', width: 10 },
    { header: 'change %', width: 11 },
    ...Array.from({ length: weekCount }, (_, i) => ({ header: periodEnds[i] || `W${i + 1}`, width: 11 })),
  ];
  const colCount = TREND_HEAD.length + weekCount;
  styleHeader(sheet, colCount);

  const sorted = [...trendRows].sort((a, b) =>
    a.url.localeCompare(b.url) || a.device.localeCompare(b.device) || a.metric.localeCompare(b.metric));

  sorted.forEach((t, i) => {
    const points = Array.from({ length: weekCount }, (_, k) => (t.points[k] === undefined ? null : t.points[k]));
    const real = points.filter((p) => p !== null);
    const oldest = real.length ? real[0] : null;
    const latest = real.length ? real[real.length - 1] : null;
    // Fewer than two real points means there is no change to speak of. Writing 0%
    // for a page with one week of data reads as "flat", which is a lie.
    const change = (real.length >= 2 && oldest !== 0)
      ? Number((((latest - oldest) / oldest) * 100).toFixed(1))
      : null;

    sheet.addRow([
      t.url, t.title || '', t.device, t.level || 'page', t.metric,
      textSparkline(points),
      real.length, oldest, latest, change,
      ...points,
    ]);

    const LATEST_COL = TREND_HEAD.indexOf('latest') + 1;
    const CHANGE_COL = TREND_HEAD.indexOf('change %') + 1;

    paint(sheet, i + 2, colCount, (col) => {
      if (col === LATEST_COL) return band(t.metric, latest);
      if (col === CHANGE_COL) {
        if (change === null) return 'none';
        if (change <= -5) return 'good';   // lower is better for all three metrics
        if (change >= 5) return 'poor';
        return 'mid';
      }
      if (col >= FIRST_WEEK_COL) return band(t.metric, points[col - FIRST_WEEK_COL]);
      return 'plain';
    });
  });

  return sheet;
}

// ----------------------------------------------------------------- PSI sheet

const PSI_COLUMNS = [
  { header: 'PSI test', width: 12 },
  { header: 'url', width: 52 },
  { header: 'pagetitle', width: 34 },
  { header: 'device', width: 10 },
  { header: 'score', width: 8 },
  { header: 'verdict', width: 13 },
  { header: 'LCP (ms)', width: 11 },
  { header: 'TBT (ms)', width: 11 },
  { header: 'CLS', width: 9 },
  { header: 'FCP (ms)', width: 11 },
  { header: 'Speed Index (ms)', width: 16 },
  { header: 'TTFB (ms)', width: 11 },
  { header: 'status', width: 46 },
  { header: 'top opportunities', width: 70 },
  { header: 'total savings (ms)', width: 17 },
  { header: 'CrUX verdict', width: 13 },
  { header: 'source', width: 20 },
  { header: 'lighthouse', width: 11 },
  { header: 'tested at', width: 19 },
];

const PSI_METRIC_COL = { 7: 'LCP', 8: 'TBT', 9: 'CLS', 10: 'FCP', 11: 'SI', 12: 'TTFB' };

function addPsiSheet(wb, psiRows, sheetName = 'PSI') {
  if (!psiRows.length) return null;

  const sheet = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] });
  sheet.columns = PSI_COLUMNS.map((c) => ({ header: c.header, width: c.width }));
  styleHeader(sheet, PSI_COLUMNS.length);

  // Worst first — the work to do belongs at the top of the screen.
  const sorted = [...psiRows].sort((a, b) => {
    const sa = a.score === null ? -1 : a.score;
    const sb = b.score === null ? -1 : b.score;
    return sa - sb || a.url.localeCompare(b.url);
  });

  sorted.forEach((r, i) => {
    const v = r.values || {};
    const row = sheet.addRow([
      'live test', r.url, r.title || '', r.device, r.score, r.verdict,
      v.LCP ?? null, v.TBT ?? null, v.CLS ?? null, v.FCP ?? null, v.SI ?? null, v.TTFB ?? null,
      r.status || '', r.opportunities || '', r.savingsMs, r.cruxVerdict || '', r.sourceGroup || '',
      r.lhVersion || '', r.testedAt,
    ]);

    const link = row.getCell(1);
    link.value = { text: 'live test', hyperlink: psiReportLink(r.url, r.device) };
    link.font = LINK_FONT;

    const rowKey = r.verdict === 'GOOD' ? 'good'
      : r.verdict === 'NEEDS WORK' ? 'mid'
      : r.verdict === 'POOR' ? 'poor' : 'none';

    // Row colour from the overall score, but each metric cell keeps its own
    // Lighthouse audit score — a red row can still hold a green CLS.
    paint(sheet, i + 2, PSI_COLUMNS.length, (col) => {
      const metric = PSI_METRIC_COL[col];
      if (metric && r.verdict !== 'ERROR') return lighthouseBand((r.auditScores || {})[metric]);
      return rowKey;
    });
  });

  return sheet;
}

// -------------------------------------------------------------- Summary sheet

function addSummarySheet(wb, { runInfo, groups, cruxRows, psiRows, trendRows, originRows }) {
  const sheet = wb.addWorksheet('Summary');
  sheet.columns = [{ width: 26 }, { width: 64 }];

  const title = sheet.addRow([`CrUX report — ${runInfo.siteLabel}`, '']);
  title.font = { bold: true, size: 14 };
  sheet.addRow([]);

  const info = [
    ['site', runInfo.siteLabel],
    ['generated', runInfo.generatedAt],
    ['source', runInfo.sourceLabel],
    ['devices', runInfo.devices.join(', ')],
    ['max URLs per group', runInfo.max ? String(runInfo.max) : 'all (no cap)'],
    ['URL filter', runInfo.filter || '(none)'],
    ['trend', runInfo.trend ? `yes - ${runInfo.trendWeeks} weeks` : 'no'],
    ['CrUX scope', runInfo.cruxScope],
    ['PageSpeed', runInfo.psiScope === 'none' ? 'no' : `yes - ${runInfo.psiScope}`],
  ];
  for (const [k, v] of info) {
    const r = sheet.addRow([k, v]);
    r.getCell(1).font = { bold: true };
  }

  sheet.addRow([]);
  const good = psiRows.filter((r) => r.verdict === 'GOOD').length;
  const needs = psiRows.filter((r) => r.verdict === 'NEEDS WORK').length;
  const poor = psiRows.filter((r) => r.verdict === 'POOR').length;
  const errored = psiRows.filter((r) => r.verdict === 'ERROR').length;

  for (const [k, v, key] of [
    ['pages tested (PageSpeed)', String(psiRows.length), null],
    ['GOOD  (90-100)', String(good), good ? 'good' : null],
    ['NEEDS WORK  (50-89)', String(needs), needs ? 'mid' : null],
    ['POOR  (0-49)', String(poor), poor ? 'poor' : null],
    ['errors', String(errored), errored ? 'none' : null],
    ['page-level CrUX rows', String(cruxRows.length), null],
    ['trend rows', String(trendRows.length), null],
  ]) {
    const r = sheet.addRow([k, v]);
    r.getCell(1).font = { bold: true };
    if (key) r.getCell(2).fill = fill(key);
  }

  // Domain-level field data: for a low-traffic site this is the only real-user
  // measurement that exists, so it belongs at the top, not buried in a sheet.
  if (originRows && originRows.length) {
    sheet.addRow([]);
    const oh = sheet.addRow(['real users (whole domain)', 'CrUX, 28-day p75']);
    oh.font = { bold: true };
    for (const r of originRows) {
      const v = r.values || {};
      const label = `${r.origin.replace(/^https?:\/\//, '')}  ·  ${r.device}`;
      if (r.cwv === 'NO DATA') {
        const row = sheet.addRow([label, 'no data for this domain']);
        row.getCell(2).fill = fill('none');
        continue;
      }
      const row = sheet.addRow([label,
        `${r.cwv}  ·  score ${r.score}  ·  LCP ${v.LCP ?? '-'}ms  ·  INP ${v.INP ?? '-'}ms  ·  CLS ${v.CLS ?? '-'}`]);
      row.getCell(2).fill = fill(r.cwv === 'PASS' ? 'good' : 'poor');
    }
  }

  sheet.addRow([]);
  const gh = sheet.addRow(['group', 'urls']);
  gh.font = { bold: true };
  for (const g of groups) {
    // Say plainly when --max left part of a group untested, so the workbook
    // cannot be mistaken for a complete picture of the site.
    const short = g.total && g.total > g.urls.length;
    const label = short
      ? `${g.urls.length} of ${g.total}  (--max left ${g.total - g.urls.length} out)  -  ${g.source}`
      : `${g.urls.length}  -  ${g.source}`;
    const row = sheet.addRow([g.name, label]);
    if (short) row.getCell(2).fill = fill('mid');
  }

  sheet.addRow([]);
  const note = sheet.addRow(['note',
    'All numbers are p75 of real Chrome users over 28 days. Rows marked level=origin carry the whole ' +
    'domain\'s numbers because that page has too little traffic of its own — they repeat across pages ' +
    'and are not a measurement of one page. The PSI sheet is lab data from one simulated run and will not match.']);
  note.getCell(1).font = { bold: true };
  note.getCell(2).alignment = { wrapText: true };

  return sheet;
}

// ------------------------------------------------------------------- public

export async function writeWorkbook(path, data) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'bulk-psi-crux-report';
  wb.created = new Date();

  addSummarySheet(wb, data);

  // Combined view across every group — once there is more than one sitemap,
  // flipping between per-group sheets to sort or filter the whole site is
  // tedious, so merge everything into one sheet first, worst score on top.
  // Skipped with a single group since it would just duplicate that sheet.
  if (data.groups.length > 1 && data.psiRows.length) {
    const used = new Set(data.groups.map((g) => g.name.toLowerCase()));
    let allName = 'All';
    for (let i = 2; used.has(allName.toLowerCase()); i++) allName = `All-${i}`;
    addPsiSheet(wb, data.psiRows, allName);
  }

  // The per-page report is PageSpeed: it works on every URL, whereas CrUX only
  // has data for pages with real traffic. One sheet per source group.
  for (const group of data.groups) {
    const rows = data.psiRows.filter((r) => r.sourceGroup === group.name);
    if (rows.length) addPsiSheet(wb, rows, group.name);
  }

  // Page-level field data only exists when it was actually asked for.
  const pageCrux = data.cruxRows.filter((r) => r.status !== undefined);
  if (pageCrux.length) {
    addCruxSheet(wb, { name: 'CrUX pages' }, pageCrux);
  }

  addTrendSheet(wb, data.trendRows);

  // Nothing to show at all would produce a file with only a summary — say so.
  if (wb.worksheets.length === 1) {
    const s = wb.getWorksheet('Summary');
    s.addRow([]);
    s.addRow(['', 'No data came back. Check the run log.']);
  }

  // --out reports/weekly.xlsx is the obvious thing to write in a scheduled
  // job, and failing on a missing folder after a 40-minute run is cruel.
  await mkdir(dirname(path), { recursive: true });

  await wb.xlsx.writeFile(path);
  return path;
}

export const __test__ = { CRUX_COLUMNS, METRIC_COL, PSI_METRIC_COL, PSI_COLUMNS, FILL, TREND_HEAD, FIRST_WEEK_COL };
