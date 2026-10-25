#!/usr/bin/env node
/**
 * The desktop app's back end: a local HTTP server over the same src/ the CLI
 * uses. Nothing here reimplements a measurement — it resolves inputs, streams a
 * run, saves what came back, and writes the exports, all by calling into src/.
 *
 * The UI is one HTML file served from here, which is why putting an Electron
 * window around it changes nothing on this side.
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join, dirname, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { buildConfig, labelFor, safeFilePart } from '../src/config.js';
import { resolveGroups, estimate, runReport, exportWorkbook } from '../src/run.js';
import { writeCsv } from '../src/report/csv.js';
import { activeProxy, request, apiErrorMessage } from '../src/http.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/**
 * A page from any website can POST to 127.0.0.1, so "it only listens locally"
 * is not access control on its own. Every /api/ call must carry this token,
 * which only the page we opened ourselves ever sees.
 */
const TOKEN = randomBytes(16).toString('hex');

/**
 * Settings live in the OS config directory, not next to the binary: an
 * installed app sits in Program Files, where writing is refused.
 */
const configDir = () =>
  join(process.env.BPCR_CONFIG_DIR || process.env.APPDATA || join(homedir(), '.config'), 'bulk-psi-crux-report');
const reportsDir = () => join(configDir(), 'reports');

async function loadSettings() {
  try {
    return JSON.parse(await readFile(join(configDir(), 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

async function saveSettings(patch) {
  const next = { ...(await loadSettings()), ...patch };
  await mkdir(configDir(), { recursive: true });
  await writeFile(join(configDir(), 'settings.json'), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** Where an exported file goes when the user has not said otherwise. */
const defaultOutDir = () => {
  const docs = join(homedir(), 'Documents');
  return existsSync(docs) ? join(docs, 'PageSpeed Reports') : join(homedir(), 'PageSpeed Reports');
};

// ------------------------------------------------------------- report store

/**
 * Every finished run is written to disk as JSON, so the Reports list survives
 * a restart and an export can be made long after the scan — without measuring
 * anything a second time.
 */
async function saveReport(cfg, data) {
  const id = randomUUID();
  const counts = ['GOOD', 'NEEDS WORK', 'POOR', 'ERROR'].reduce((acc, v) => {
    acc[v] = data.psiRows.filter((r) => r.verdict === v).length;
    return acc;
  }, {});

  const report = {
    id,
    label: cfg.siteLabel,
    when: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
    rows: data.psiRows.length,
    counts,
    stopped: !!data.stopped,
    // Enough config to rebuild a workbook later, without the key.
    cfg: { ...cfg, apiKey: undefined, psiKey: undefined },
    data: { ...data, titles: undefined },
  };

  await mkdir(reportsDir(), { recursive: true });
  await writeFile(join(reportsDir(), `${id}.json`), JSON.stringify(report), 'utf8');
  return report;
}

async function listReports() {
  let files = [];
  try { files = await readdir(reportsDir()); } catch { return []; }

  const out = [];
  for (const f of files.filter((n) => n.endsWith('.json'))) {
    try {
      const r = JSON.parse(await readFile(join(reportsDir(), f), 'utf8'));
      out.push({ id: r.id, label: r.label, when: r.when, rows: r.rows, counts: r.counts, stopped: r.stopped });
    } catch { /* a half-written file is not worth failing the whole list over */ }
  }
  return out.sort((a, b) => String(b.when).localeCompare(String(a.when)));
}

const readReport = async (id) =>
  JSON.parse(await readFile(join(reportsDir(), `${String(id).replace(/[^a-f0-9-]/gi, '')}.json`), 'utf8'));

// --------------------------------------------------------------- run state

/** The run in progress, if any — one window scans one thing at a time. */
let current = null;      // { abort, cfg }
/** The last finished run, so Export does not have to re-measure. */
let lastRun = null;      // { cfg, data }

// --------------------------------------------------------------- config build

/**
 * Turn what the form sent into the same config object the CLI builds, so both
 * front ends are validated by one set of rules rather than two.
 */
async function configFrom(body) {
  const settings = await loadSettings();
  const key = body.apiKey || settings.apiKey;
  if (!key) throw new Error('No API key saved yet. Add one under Settings.');

  const args = { key, devices: (body.devices || ['mobile']).join(','), max: String(body.max ?? 'all') };
  if (body.filter) args.filter = body.filter;
  if (body.crux && body.crux !== 'none') args.crux = body.crux;
  if (body.psi) args.psi = body.psi;
  if (body.concurrency) args.concurrency = String(body.concurrency);
  if (body.psiConcurrency) args['psi-concurrency'] = String(body.psiConcurrency);

  // One sitemap input: the server works out whether it is an index.
  if (body.mode === 'sitemap' || body.mode === 'sitemap-index') args['sitemap-index'] = body.value;
  else args.url = body.value;          // a pasted list, or a file's contents

  const cfg = buildConfig(args);

  // A file keeps its own name in the report; a paste is named after its first
  // host, which buildConfig already worked out.
  if (body.filename) cfg.siteLabel = labelFor('file', body.filename);
  if (body.pick) cfg.pick = body.pick;
  return cfg;
}

/** `pagespeed-example.com-2026-10-25-19-04.xlsx` */
const outName = (cfg, ext) => {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const kind = cfg.cruxScope && cfg.cruxScope !== 'none' ? 'speed' : 'pagespeed';
  return `${kind}-${safeFilePart(cfg.siteLabel || 'site')}-${stamp}.${ext}`;
};

// ------------------------------------------------------------------- handlers

const readBody = (req) => new Promise((ok, fail) => {
  let raw = '';
  req.on('data', (c) => {
    raw += c;
    if (raw.length > 8e6) { fail(new Error('That input is too large.')); req.destroy(); }
  });
  req.on('end', () => {
    try { ok(raw ? JSON.parse(raw) : {}); } catch { fail(new Error('Malformed request.')); }
  });
  req.on('error', fail);
});

const json = (res, code, payload) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
};

/**
 * One real call before the run starts.
 *
 * Without it, a dead proxy or a restricted key turns every test in a 400-page
 * scan into its own error row, forty minutes of them, all saying the same
 * thing. This fails in seconds and says which of the three it is.
 *
 * It goes through request() rather than fetch so it inherits the retries: a
 * tunnel reconnecting throws one ECONNRESET and is fine a second later, and
 * refusing to start a scan over that would be worse than not checking at all.
 */
async function preflight(body) {
  const key = (body.apiKey || (await loadSettings()).apiKey || '').trim();
  if (!key) return { ok: false, detail: 'No API key saved yet.', advice: 'Add one under Settings.' };

  const url = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed'
    + '?url=https%3A%2F%2Fexample.com&category=performance&key=' + encodeURIComponent(key);

  const res = await request(url, { timeout: 60000, retries: 2 });
  if (res.ok) return { ok: true };

  const proxy = activeProxy();
  const detail = apiErrorMessage(res, 'the request failed');

  // status 0 means it never reached Google at all — network, not key.
  const advice = res.status === 0
    ? (proxy
        ? `Node sends this through the proxy at ${proxy}, and it failed three times. Your browser may not be using that proxy, which is why pages open fine while this does not.`
        : 'No proxy is configured for Node, so this went out directly. Check the connection.')
    : res.status === 403
      ? 'A 403 is usually a key restricted to referrers or IP addresses — it has to be None for a server-to-server call — or the API not enabled on the project.'
      : res.status === 429
        ? 'The per-minute quota is used up. Wait a minute and try again.'
        : 'Check the key under Settings.';

  return { ok: false, status: res.status, detail, advice };
}

/**
 * Resolve the input and price the run, without spending anything.
 *
 * A sitemap index with nothing picked yet comes back as a list of children for
 * the user to tick, which is the GUI's version of the CLI's prompt.
 */
async function handleResolve(body) {
  const cfg = await configFrom(body);
  try {
    const groups = await resolveGroups(cfg);
    return {
      ok: true,
      siteLabel: cfg.siteLabel,
      groups: groups.map((g) => ({ name: g.name, source: g.source, urls: g.urls.length, total: g.total })),
      plan: estimate(cfg, groups),
    };
  } catch (e) {
    if (e.children) return { ok: true, needPick: true, children: e.children };
    throw e;
  }
}

/** Run, streaming one JSON event per line as each test lands. */
async function handleRun(body, res) {
  const cfg = await configFrom(body);
  const groups = await resolveGroups(cfg);

  const abort = new AbortController();
  current = { abort, cfg };

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
  const send = (event) => res.write(JSON.stringify(event) + '\n');

  // The browser going away mid-run should stop the work, not leave it burning
  // quota against a window nobody is watching.
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });

  send({ type: 'plan', ...estimate(cfg, groups), siteLabel: cfg.siteLabel });

  try {
    const data = await runReport(cfg, groups, send, abort.signal);
    lastRun = { cfg, data };
    const saved = data.psiRows.length ? await saveReport(cfg, data) : null;

    send({
      type: 'done',
      stopped: !!data.stopped,
      reportId: saved ? saved.id : null,
      counts: saved ? saved.counts : {},
      origins: data.originRows.map((r) => ({
        origin: r.origin, device: r.device, cwv: r.cwv, score: r.score, values: r.values,
      })),
    });
  } catch (e) {
    send({ type: 'error', message: String(e.message || e) });
  } finally {
    current = null;
    res.end();
  }
}

/** Write a workbook or a CSV, for the last run or any saved report. */
async function handleExport(body) {
  let cfg, rows;

  if (body.id) {
    const report = await readReport(body.id);
    cfg = report.cfg;
    rows = report.data.psiRows;
  } else {
    if (!lastRun) throw new Error('Nothing to export yet — run a scan first.');
    cfg = lastRun.cfg;
    rows = lastRun.data.psiRows;
  }

  const dir = body.dir || (await loadSettings()).outDir || defaultOutDir();
  const format = body.format === 'csv' ? 'csv' : 'xlsx';
  const path = join(dir, outName(cfg, format));

  if (format === 'csv') {
    await writeCsv(path, rows);
  } else {
    const data = body.id ? (await readReport(body.id)).data : lastRun.data;
    await exportWorkbook(cfg, data, path);
  }

  lastExport = path;
  return { ok: true, path, format };
}

let lastExport = null;

/** Show a finished file in Explorer / Finder / the desktop's file manager. */
function revealFile(path) {
  const [cmd, args] = process.platform === 'win32' ? ['explorer', [`/select,${path}`]]
    : process.platform === 'darwin' ? ['open', ['-R', path]]
    : ['xdg-open', [dirname(path)]];
  // explorer.exe returns 1 even when it works, so its exit code says nothing.
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

const STATIC = {
  '/': ['app.html', 'text/html; charset=utf-8'],
  '/app.html': ['app.html', 'text/html; charset=utf-8'],
};

export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;

    // Refuse a hostname that is not loopback: a DNS name pointed at 127.0.0.1
    // would otherwise let a remote page treat this as its own origin.
    const host = (req.headers.host || '').split(':')[0];
    if (host && !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
      return json(res, 403, { error: 'Only reachable as 127.0.0.1.' });
    }

    try {
      if (STATIC[path]) {
        const [file, type] = STATIC[path];
        res.writeHead(200, { 'content-type': type });
        return res.end(await readFile(join(HERE, file)));
      }

      // score.js runs unchanged in the browser, so the table's colours come
      // from the same thresholds the workbook uses.
      if (path === '/score.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        return res.end(await readFile(join(ROOT, 'src', 'score.js')));
      }
      if (path === '/icon.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(await readFile(join(ROOT, 'build', 'icon.png')));
      }

      if (!path.startsWith('/api/')) return json(res, 404, { error: 'Not found' });

      const token = url.searchParams.get('t') || req.headers['x-token'];
      if (token !== TOKEN) return json(res, 403, { error: 'Bad or missing token.' });

      if (path === '/api/settings' && req.method === 'GET') {
        const s = await loadSettings();
        // Never hand the key back out; the UI only needs to know there is one.
        return json(res, 200, {
          hasKey: !!s.apiKey,
          keyTail: s.apiKey ? '…' + s.apiKey.slice(-6) : null,
          outDir: s.outDir || defaultOutDir(),
        });
      }

      const body = req.method === 'POST' ? await readBody(req) : {};

      if (path === '/api/settings') {
        const patch = {};
        if (typeof body.apiKey === 'string') patch.apiKey = body.apiKey.trim();
        if (typeof body.outDir === 'string') patch.outDir = body.outDir.trim();
        await saveSettings(patch);
        return json(res, 200, { ok: true });
      }

      if (path === '/api/preflight') return json(res, 200, await preflight(body));
      if (path === '/api/resolve') return json(res, 200, await handleResolve(body));
      if (path === '/api/run') return await handleRun(body, res);

      if (path === '/api/stop') {
        if (current) current.abort.abort();
        return json(res, 200, { ok: true, stopping: !!current });
      }

      if (path === '/api/reports') return json(res, 200, { reports: await listReports() });

      if (path === '/api/report') {
        const r = await readReport(body.id);
        return json(res, 200, { ok: true, label: r.label, when: r.when, rows: r.data.psiRows });
      }

      if (path === '/api/report-delete') {
        await rm(join(reportsDir(), `${String(body.id).replace(/[^a-f0-9-]/gi, '')}.json`), { force: true });
        return json(res, 200, { ok: true });
      }

      if (path === '/api/export') return json(res, 200, await handleExport(body));

      if (path === '/api/reveal') {
        if (!lastExport) throw new Error('No file to show yet.');
        revealFile(lastExport);
        return json(res, 200, { ok: true });
      }

      if (path === '/api/quit') {
        json(res, 200, { ok: true });
        return setTimeout(() => process.exit(0), 100);
      }

      return json(res, 404, { error: 'Not found' });
    } catch (e) {
      if (res.headersSent) return res.end();
      return json(res, 400, { error: String(e.message || e) });
    }
  });
}

/** Open the default browser at the app, whichever OS this is. */
function openBrowser(target) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', target]]
    : process.platform === 'darwin' ? ['open', [target]]
    : ['xdg-open', [target]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

export function start({ port = 0, open = true } = {}) {
  const server = createApp();
  return new Promise((ok, fail) => {
    // A busy port otherwise surfaces as an unhandled 'error' event and a stack
    // trace, which tells the person running the app nothing they can act on.
    server.on('error', (e) => {
      fail(e.code === 'EADDRINUSE'
        ? new Error(`Port ${port} is already in use. Close the other copy, or set PORT to something else.`)
        : e);
    });
    server.listen(port, '127.0.0.1', () => {
      const target = `http://127.0.0.1:${server.address().port}/?t=${TOKEN}`;
      console.log('Elin PageSpeed Insight  —  ' + target);
      if (open) openBrowser(target);
      ok({ server, url: target, token: TOKEN, port: server.address().port });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  start({ port: Number(process.env.PORT) || 0, open: !process.argv.includes('--no-open') })
    .then(() => console.log('Close this window to quit.'))
    .catch((e) => {
      console.error(String(e.message || e));
      process.exit(1);
    });
}
