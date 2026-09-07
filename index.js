#!/usr/bin/env node
import { resolve } from 'node:path';
import { loadEnv, parseArgs, buildConfig, HELP } from './src/config.js';
import { makeFilter, groupFromSitemap, listIndexChildren, groupsFromChildren } from './src/sources/sitemap.js';
import { groupFromTextFile } from './src/sources/textfile.js';
import { pickSitemaps } from './src/prompt.js';
import { fetchCurrent, fetchHistory, originOf } from './src/crux.js';
import { fetchPsi } from './src/psi.js';
import { fetchTitles } from './src/titles.js';
import { Limiter } from './src/limiter.js';
import { CORE_METRICS } from './src/score.js';
import { writeWorkbook } from './src/report/workbook.js';

/** CrUX allows 150 queries/minute and it cannot be raised — stay under it. */
const CRUX_PER_MINUTE = 130;
/**
 * PageSpeed throughput does not scale with concurrency: Google queues the
 * Lighthouse runs its own side. A sweep over 20 distinct URLs each time gave
 *
 *     concurrency 10 -> 11 calls/min
 *     concurrency 20 -> 16 calls/min
 *     concurrency 40 -> 23 calls/min
 *
 * which is close to 3.6 * sqrt(concurrency) — four times the parallelism buys
 * about twice the speed. The 240/min quota is never the binding constraint;
 * at concurrency 40 we still only reach a tenth of it.
 */
const psiRatePerMinute = (concurrency) => 3.6 * Math.sqrt(concurrency);

/**
 * Past this, every extra request in flight is another simultaneous crawl of the
 * site being measured. In the same sweep the tested site's own TTFB went from
 * ~33ms to ~73ms at concurrency 40 — at that point the report is partly a
 * measurement of the load test it is running.
 */
const PSI_CROWDING_THRESHOLD = 20;

let quiet = false;
const say = (...a) => { if (!quiet) console.log(...a); };

function progress(label) {
  let last = 0;
  return (done, total) => {
    if (quiet) return;
    const pct = Math.floor((done / total) * 100);
    if (pct === last && done !== total) return;
    last = pct;
    const bar = '█'.repeat(Math.floor(pct / 5)).padEnd(20, '·');
    process.stdout.write(`\r  ${label} ${bar} ${done}/${total}`);
    if (done === total) process.stdout.write('\n');
  };
}

async function resolveGroups(cfg) {
  const filter = makeFilter(cfg.filter);

  if (cfg.source === 'file') {
    say(`Reading URLs from ${cfg.target}`);
    return groupFromTextFile(cfg.target, { max: cfg.max, filter });
  }

  if (cfg.source === 'sitemap') {
    say(`Reading sitemap: ${cfg.target}`);
    return groupFromSitemap(cfg.target, { max: cfg.max, filter });
  }

  say(`Reading sitemap index: ${cfg.target}`);
  const children = await listIndexChildren(cfg.target, {
    concurrency: 5,
    onProgress: progress('sitemaps '),
  });
  const chosen = await pickSitemaps(children, { preset: cfg.pick });
  return groupsFromChildren(chosen, { max: cfg.max, filter });
}

async function main() {
  await loadEnv(resolve(process.cwd(), '.env'));
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h || process.argv.length <= 2) {
    console.log(HELP);
    process.exit(0);
  }

  const cfg = buildConfig(args);
  quiet = cfg.quiet;

  const groups = await resolveGroups(cfg);
  const totalUrls = groups.reduce((s, g) => s + g.urls.length, 0);

  say('');
  say(`${groups.length} group(s), ${totalUrls} URLs, devices: ${cfg.devices.join(' + ')}`);

  // A cap that quietly drops most of a sitemap produces a report that looks
  // complete and is not. Name it, per group, with the fix.
  const capped = groups.filter((g) => g.total && g.total > g.urls.length);
  if (capped.length) {
    const dropped = capped.reduce((n, g) => n + (g.total - g.urls.length), 0);
    say('');
    say(`  !  --max ${cfg.max} left out ${dropped} URLs:`);
    for (const g of capped) say(`       ${g.name}: testing ${g.urls.length} of ${g.total}`);
    say('       pass --max all to test every URL');
  }

  const domainCount = new Set(groups.flatMap((g) => g.urls.map(originOf)).filter(Boolean)).size;
  const perDevice = cfg.devices.length;
  const cruxCalls = cfg.cruxScope === 'none' ? 0
    : cfg.cruxScope === 'origin'
      ? domainCount * perDevice * (cfg.trend ? 2 : 1)
      : totalUrls * perDevice * (cfg.trend ? 2 : 1) + domainCount * perDevice;
  const psiCalls = cfg.psiScope === 'all' ? totalUrls * perDevice : 0;
  const psiConcurrency = cfg.psiConcurrency;

  if (cruxCalls) say(`CrUX: ${cruxCalls} calls (scope=${cfg.cruxScope}, quota ${CRUX_PER_MINUTE}/min)`);
  if (psiCalls) {
    const mins = Math.ceil(psiCalls / psiRatePerMinute(psiConcurrency));
    say(`PageSpeed: ${psiCalls} calls, ${psiConcurrency} at a time - roughly ${mins} min`);
    if (psiConcurrency > PSI_CROWDING_THRESHOLD) {
      say(`  !  ${psiConcurrency} parallel runs means ${psiConcurrency} simultaneous crawls of your own`);
      say('     site. Its response time suffers, and the scores come back worse');
      say('     than they would under normal traffic.');
    }
  }
  say('');

  // ---- 1. current field data ------------------------------------------------
  const tasks = [];
  for (const g of groups) {
    for (const url of g.urls) {
      for (const device of cfg.devices) tasks.push({ url, device, group: g.name });
    }
  }

  const cruxLimiter = new Limiter({ concurrency: cfg.concurrency, perMinute: CRUX_PER_MINUTE });

  // The domains in play — one origin call per domain and device is nearly free
  // and is the only real-user data a low-traffic site has at all.
  const domains = [...new Set(tasks.map((t) => originOf(t.url)).filter(Boolean))];

  let cruxRows = [];
  const originRows = [];

  if (cfg.cruxScope === 'pages') {
    cruxRows = await cruxLimiter.map(
      tasks,
      async (t) => ({ ...(await fetchCurrent({ url: t.url, device: t.device, apiKey: cfg.apiKey })), sourceGroup: t.group }),
      progress('CrUX      ')
    );
  }

  // Domain-level field data. Under `pages` it also backfills any page that had
  // none of its own, marked level=origin so a domain average is never mistaken
  // for a measurement of one page.
  if (cfg.cruxScope !== 'none') {
    const wanted = [];
    for (const origin of domains) for (const device of cfg.devices) wanted.push({ origin, device });

    if (wanted.length) {
      say(`  Domain-level data: ${wanted.length} calls for ${domains.length} domain(s)`);
      const fetched = await cruxLimiter.map(
        wanted,
        (w) => fetchCurrent({ origin: w.origin, device: w.device, apiKey: cfg.apiKey }),
        progress('domain    ')
      );
      fetched.forEach((row, i) => originRows.push({ ...row, origin: wanted[i].origin }));

      if (cfg.cruxScope === 'pages' && cfg.originFallback) {
        const byKey = new Map(originRows.map((r) => [`${r.origin}|${r.device}`, r]));
        for (const row of cruxRows) {
          if (row.cwv !== 'NO DATA') continue;
          const hit = byKey.get(`${originOf(row.url)}|${row.device}`);
          if (!hit || hit.cwv === 'NO DATA') continue;
          Object.assign(row, {
            level: 'origin', status: hit.status, score: hit.score,
            cwv: hit.cwv, values: hit.values, good: hit.good,
          });
        }
      }
    }
  }

  // ---- 2. page titles -------------------------------------------------------
  const titles = await fetchTitles(tasks.map((t) => t.url), {
    concurrency: 5,
    onProgress: progress('titles    '),
  });
  for (const row of cruxRows) row.title = titles.get(row.url) || '';

  // ---- 3. weekly history ----------------------------------------------------
  const trendRows = [];
  if (cfg.trend) {
    const histTasks = [];
    for (const g of groups) {
      for (const url of g.urls) {
        for (const device of cfg.devices) histTasks.push({ url, device, group: g.name });
      }
    }
    // A page with no current data has no history either, so ask the domain for
    // those instead of burning a call per URL on a guaranteed 404.
    const pageLevel = new Set(
      cruxRows.filter((r) => r.level === 'page' && r.cwv !== 'NO DATA').map((r) => `${r.url}|${r.device}`)
    );
    const seenOrigin = new Set();
    const histPlan = [];

    if (cfg.cruxScope === 'origin') {
      // Domain scope: exactly one history call per domain and device.
      for (const origin of domains) {
        for (const device of cfg.devices) histPlan.push({ origin, device, level: 'origin' });
      }
    } else {
      for (const t of histTasks) {
        if (!cfg.originFallback || pageLevel.has(`${t.url}|${t.device}`)) {
          histPlan.push({ ...t, level: 'page' });
          continue;
        }
        const origin = originOf(t.url);
        const key = `${origin}|${t.device}`;
        if (!origin || seenOrigin.has(key)) continue;   // one history call per domain+device
        seenOrigin.add(key);
        histPlan.push({ ...t, origin, level: 'origin' });
      }
    }

    const results = await cruxLimiter.map(
      histPlan,
      (t) => fetchHistory({
        url: t.level === 'page' ? t.url : undefined,
        origin: t.level === 'origin' ? t.origin : undefined,
        device: t.device, apiKey: cfg.apiKey, weeks: cfg.trendWeeks,
      }),
      progress('trend     ')
    );
    for (const r of results) {
      for (const metric of CORE_METRICS) {
        if (!(r.series[metric] || []).some((p) => p !== null)) continue;   // skip empty series
        trendRows.push({
          url: r.url,
          device: r.device,
          level: r.level,
          title: titles.get(r.url) || '',
          metric,
          points: r.series[metric] || [],
          periodEnds: r.periodEnds,
        });
      }
    }
  }

  // ---- 4. PageSpeed ---------------------------------------------------------
  const psiRows = [];
  if (cfg.psiScope !== 'none') {
    // Under `all` the page list comes from the source, not from CrUX — CrUX may
    // not have been asked about individual pages at all.
    const candidates = cfg.psiScope === 'all'
      ? tasks.map((t) => ({
          url: t.url, device: t.device, sourceGroup: t.group,
          title: titles.get(t.url) || '',
          cwv: (cruxRows.find((r) => r.url === t.url && r.device === t.device) || {}).cwv || '',
        }))
      : cruxRows.filter((r) => r.cwv === 'FAIL');

    if (!candidates.length) {
      say(cfg.psiScope === 'failed'
        ? '  PageSpeed: nothing failed, skipping'
        : '  PageSpeed: nothing to test');
    } else {
      say(`  PageSpeed: ${candidates.length} pages (slow - seconds each)`);
      const psiLimiter = new Limiter({ concurrency: cfg.psiConcurrency, perMinute: 200 });
      const results = await psiLimiter.map(
        candidates,
        (r) => fetchPsi({ url: r.url, device: r.device, apiKey: cfg.psiKey }),
        progress('PageSpeed ')
      );
      results.forEach((res, i) => psiRows.push({
        ...res,
        title: candidates[i].title,
        cruxVerdict: candidates[i].cwv,
        sourceGroup: candidates[i].sourceGroup,
      }));
    }
  }

  // ---- 5. workbook ----------------------------------------------------------
  const outPath = resolve(process.cwd(), cfg.out);
  await writeWorkbook(outPath, {
    runInfo: {
      siteLabel: cfg.siteLabel,
      generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
      sourceLabel: `${cfg.source}: ${cfg.target}`,
      devices: cfg.devices,
      max: cfg.max,
      filter: cfg.filter,
      trend: cfg.trend,
      trendWeeks: cfg.trendWeeks,
      cruxScope: cfg.cruxScope,
      psiScope: cfg.psiScope,
    },
    groups, cruxRows, trendRows, psiRows, originRows,
  });

  say('');

  if (psiRows.length) {
    const n = (v) => psiRows.filter((r) => r.verdict === v).length;
    say(`PageSpeed  -  GOOD ${n('GOOD')}   NEEDS WORK ${n('NEEDS WORK')}   POOR ${n('POOR')}   errors ${n('ERROR')}`);
  }

  for (const r of originRows) {
    const host = r.origin.replace(/^https?:\/\//, '');
    say(r.cwv === 'NO DATA'
      ? `Real users  -  ${host} / ${r.device}: no data`
      : `Real users  -  ${host} / ${r.device}: ${r.cwv} (score ${r.score}, LCP ${r.values.LCP ?? '-'}ms)`);
  }

  const nodata = cruxRows.filter((r) => r.cwv === 'NO DATA').length;
  if (nodata) say(`(${nodata} pages had no CrUX data - not an error, just too little traffic)`);

  say('');
  console.log(outPath);
}

main().catch((e) => {
  console.error('');
  console.error(String(e.message || e));
  process.exit(1);
});
