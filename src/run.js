import { resolve } from 'node:path';
import { makeFilter, groupFromSitemap, listIndexChildren, groupsFromChildren, readSitemap } from './sources/sitemap.js';
import { groupFromTextFile, groupFromUrls } from './sources/textfile.js';
import { fetchCurrent, fetchHistory, originOf } from './crux.js';
import { fetchPsi } from './psi.js';
import { fetchTitles } from './titles.js';
import { Limiter } from './limiter.js';
import { CORE_METRICS } from './score.js';
import { writeWorkbook } from './report/workbook.js';

/** CrUX allows 150 queries/minute and it cannot be raised — stay under it. */
export const CRUX_PER_MINUTE = 130;

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
export const psiRatePerMinute = (concurrency) => 3.6 * Math.sqrt(concurrency);

/**
 * Past this, every extra request in flight is another simultaneous crawl of the
 * site being measured. In the same sweep the tested site's own TTFB went from
 * ~33ms to ~73ms at concurrency 40 — at that point the report is partly a
 * measurement of the load test it is running.
 */
export const PSI_CROWDING_THRESHOLD = 20;

/**
 * Resolve the input into groups of URLs.
 *
 * A sitemap index needs a choice made between listing its children and reading
 * them, which a GUI makes in a separate request and the CLI makes at a prompt.
 * `pick` does that: given one, this runs straight through; given none for an
 * index, it throws with the children attached so the caller can ask.
 */
export async function resolveGroups(cfg, emit = () => {}, onNeedPick = null) {
  const filter = makeFilter(cfg.filter);

  if (cfg.source === 'url') {
    return groupFromUrls(cfg.target, { max: cfg.max, filter });
  }
  if (cfg.source === 'file') {
    emit({ type: 'reading', what: cfg.target });
    return groupFromTextFile(cfg.target, { max: cfg.max, filter });
  }
  // A sitemap and a sitemap index are the same input as far as the person is
  // concerned: one URL they copied from robots.txt. Which one it is, is a fact
  // about the document, so read it and find out rather than asking.
  emit({ type: 'reading', what: cfg.target });
  const { xml, isIndex } = await readSitemap(cfg.target);

  if (!isIndex) {
    return groupFromSitemap(cfg.target, { max: cfg.max, filter, xml });
  }

  const children = await listIndexChildren(cfg.target, {
    concurrency: 5,
    onProgress: (done, total) => emit({ type: 'phase', phase: 'sitemaps', done, total }),
    xml,
  });
  // A pick given up front runs straight through; otherwise ask the caller, and
  // if it has no way to ask, hand the children back so it can ask separately.
  const chosen = cfg.pick ? selectChildren(children, cfg.pick)
    : onNeedPick ? await onNeedPick(children)
    : null;

  if (!chosen || !chosen.length) {
    const e = new Error('This sitemap index needs a selection.');
    e.children = children.map(({ url, name, count, error, nested }) => ({ url, name, count, error, nested }));
    throw e;
  }
  return groupsFromChildren(chosen, { max: cfg.max, filter });
}

/** `all`, `1,3`, `2-4`, or an array of indexes the GUI ticked. */
export function selectChildren(children, pick) {
  if (Array.isArray(pick)) return pick.map((i) => children[i]).filter(Boolean);
  const spec = String(pick).trim().toLowerCase();
  if (spec === 'all' || spec === 'a') return children;

  const wanted = new Set();
  for (const part of spec.split(',')) {
    const range = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      for (let i = Number(range[1]); i <= Number(range[2]); i++) wanted.add(i);
    } else if (/^\d+$/.test(part.trim())) {
      wanted.add(Number(part.trim()));
    }
  }
  const chosen = [...wanted].sort((a, b) => a - b).map((n) => children[n - 1]).filter(Boolean);
  if (!chosen.length) throw new Error(`"${pick}" did not select any of the ${children.length} sitemaps.`);
  return chosen;
}

/** What the run will cost, before any of it is spent. */
export function estimate(cfg, groups) {
  const totalUrls = groups.reduce((s, g) => s + g.urls.length, 0);
  const domainCount = new Set(groups.flatMap((g) => g.urls.map(originOf)).filter(Boolean)).size;
  const perDevice = cfg.devices.length;

  const cruxCalls = cfg.cruxScope === 'none' ? 0
    : cfg.cruxScope === 'origin'
      ? domainCount * perDevice * (cfg.trend ? 2 : 1)
      : totalUrls * perDevice * (cfg.trend ? 2 : 1) + domainCount * perDevice;
  const psiCalls = cfg.psiScope === 'all' ? totalUrls * perDevice : 0;

  return {
    totalUrls,
    domainCount,
    cruxCalls,
    psiCalls,
    psiConcurrency: cfg.psiConcurrency,
    etaMinutes: psiCalls ? Math.ceil(psiCalls / psiRatePerMinute(cfg.psiConcurrency)) : 0,
    crowding: cfg.psiConcurrency > PSI_CROWDING_THRESHOLD,
    // A cap that quietly drops most of a sitemap produces a report that looks
    // complete and is not. Name it, per group, so the caller can say so.
    capped: groups
      .filter((g) => g.total && g.total > g.urls.length)
      .map((g) => ({ name: g.name, testing: g.urls.length, of: g.total })),
  };
}

/**
 * The whole run, emitting structured events as it goes.
 *
 * Every phase pushes `{type:'phase', phase, done, total}`, and each finished
 * PageSpeed test also pushes `{type:'row', row}` so a UI can fill a table live
 * instead of waiting out the whole run for a file.
 *
 * `signal` stops it. Stopping keeps every result already in hand: the person
 * who pressed stop wants the twenty minutes they already waited for, not an
 * empty report.
 */
export async function runReport(cfg, groups, emit = () => {}, signal = null) {
  const tasks = [];
  for (const g of groups) {
    for (const url of g.urls) {
      for (const device of cfg.devices) tasks.push({ url, device, group: g.name });
    }
  }

  const cruxLimiter = new Limiter({ concurrency: cfg.concurrency, perMinute: CRUX_PER_MINUTE, signal });
  const phase = (name) => (done, total) => emit({ type: 'phase', phase: name, done, total });

  // The domains in play — one origin call per domain and device is nearly free
  // and is the only real-user data a low-traffic site has at all.
  const domains = [...new Set(tasks.map((t) => originOf(t.url)).filter(Boolean))];

  let cruxRows = [];
  const originRows = [];

  if (cfg.cruxScope === 'pages') {
    cruxRows = await cruxLimiter.map(
      tasks,
      async (t) => ({ ...(await fetchCurrent({ url: t.url, device: t.device, apiKey: cfg.apiKey, signal })), sourceGroup: t.group }),
      phase('crux')
    );
  }

  // Domain-level field data. Under `pages` it also backfills any page that had
  // none of its own, marked level=origin so a domain average is never mistaken
  // for a measurement of one page.
  if (cfg.cruxScope !== 'none') {
    const wanted = [];
    for (const origin of domains) for (const device of cfg.devices) wanted.push({ origin, device });

    if (wanted.length) {
      const fetched = await cruxLimiter.map(
        wanted,
        // The origin travels with the result: a cancelled run drops jobs, so
        // lining results up against the input list by index would mislabel them.
        async (w) => ({ ...(await fetchCurrent({ origin: w.origin, device: w.device, apiKey: cfg.apiKey, signal })), origin: w.origin }),
        phase('domain')
      );
      originRows.push(...fetched);

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

  const titles = await fetchTitles(tasks.map((t) => t.url), {
    concurrency: 5,
    onProgress: phase('titles'),
    signal,
  });
  for (const row of cruxRows) row.title = titles.get(row.url) || '';

  const trendRows = [];
  if (cfg.trend) {
    // A page with no current data has no history either, so ask the domain for
    // those instead of burning a call per URL on a guaranteed 404.
    const pageLevel = new Set(
      cruxRows.filter((r) => r.level === 'page' && r.cwv !== 'NO DATA').map((r) => `${r.url}|${r.device}`)
    );
    const seenOrigin = new Set();
    const histPlan = [];

    if (cfg.cruxScope === 'origin') {
      for (const origin of domains) {
        for (const device of cfg.devices) histPlan.push({ origin, device, level: 'origin' });
      }
    } else {
      for (const t of tasks) {
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
        device: t.device, apiKey: cfg.apiKey, weeks: cfg.trendWeeks, signal,
      }),
      phase('trend')
    );
    for (const r of results) {
      for (const metric of CORE_METRICS) {
        if (!(r.series[metric] || []).some((p) => p !== null)) continue;   // skip empty series
        trendRows.push({
          url: r.url, device: r.device, level: r.level,
          title: titles.get(r.url) || '',
          metric, points: r.series[metric] || [], periodEnds: r.periodEnds,
        });
      }
    }
  }

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

    if (candidates.length) {
      const psiLimiter = new Limiter({ concurrency: cfg.psiConcurrency, perMinute: 200, signal });
      await psiLimiter.map(
        candidates,
        (r) => fetchPsi({ url: r.url, device: r.device, apiKey: cfg.psiKey, signal }),
        (done, total, result, item) => {
          // null means the user stopped before this test returned.
          if (!result) return;
          const row = {
            ...result,
            title: item.title,
            cruxVerdict: item.cwv,
            sourceGroup: item.sourceGroup,
          };
          psiRows.push(row);
          emit({ type: 'row', row });
          emit({ type: 'phase', phase: 'psi', done, total });
        }
      );
    }
  }

  return { groups, cruxRows, trendRows, psiRows, originRows, titles, stopped: !!(signal && signal.aborted) };
}

/** Write the workbook for a finished run. */
export async function exportWorkbook(cfg, data, outPath = cfg.out) {
  const full = resolve(process.cwd(), outPath);
  await writeWorkbook(full, {
    runInfo: {
      siteLabel: cfg.siteLabel,
      generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
      sourceLabel: `${cfg.source}: ${Array.isArray(cfg.target) ? `${cfg.target.length} URLs` : cfg.target}`,
      devices: cfg.devices,
      max: cfg.max,
      filter: cfg.filter,
      trend: cfg.trend,
      trendWeeks: cfg.trendWeeks,
      cruxScope: cfg.cruxScope,
      psiScope: cfg.psiScope,
    },
    ...data,
  });
  return full;
}
