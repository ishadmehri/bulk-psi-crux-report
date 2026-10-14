#!/usr/bin/env node
/**
 * The desktop app's back end: a local HTTP server over the same src/ the CLI
 * uses. Nothing here reimplements a measurement — it resolves inputs, streams a
 * run, and writes the workbook, all by calling into src/.
 *
 * The UI is one HTML file served from here, so wrapping this in an Electron
 * window later changes nothing on this side.
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join, dirname, resolve, basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { buildConfig, labelFor } from '../src/config.js';
import { groupFromUrls } from '../src/sources/textfile.js';
import { resolveGroups, estimate, runReport, exportWorkbook } from '../src/run.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/**
 * A page from any website can POST to 127.0.0.1, so "it only listens locally"
 * is not access control on its own. Every /api/ call must carry this token,
 * which only the page we opened ourselves ever sees.
 */
const TOKEN = randomBytes(16).toString('hex');

/**
 * Settings live in the OS config directory, not next to the binary: a packaged
 * app can sit in Program Files where writing is refused.
 */
const configDir = () =>
  join(process.env.BPCR_CONFIG_DIR || process.env.APPDATA || join(homedir(), '.config'), 'bulk-psi-crux-report');

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

/** Where a report goes when the user has not said. */
const defaultOutDir = () => {
  const docs = join(homedir(), 'Documents');
  return existsSync(docs) ? join(docs, 'PageSpeed Reports') : join(homedir(), 'PageSpeed Reports');
};

/**
 * The last finished run, so Export can write a workbook without measuring
 * everything again.
 *
 * ponytail: one run at a time, which is all a single local window can show.
 * Key it by an id if the UI ever grows tabs.
 */
let lastRun = null;

// --------------------------------------------------------------- config build

/**
 * Turn what the form sent into the same config object the CLI builds, so both
 * front ends are validated by one set of rules instead of two.
 */
async function configFrom(body) {
  const settings = await loadSettings();
  const key = body.apiKey || settings.apiKey;
  if (!key) throw new Error('No API key saved yet. Add one in Settings.');

  // The GUI holds a file's *contents* (a browser never hands over a path), so
  // those arrive as text and go down the same path as a pasted list.
  const args = { key, devices: (body.devices || ['mobile']).join(','), max: String(body.max ?? 50) };
  if (body.filter) args.filter = body.filter;
  if (body.crux && body.crux !== 'none') args.crux = body.crux;
  if (body.psi) args.psi = body.psi;
  if (body.concurrency) args.concurrency = String(body.concurrency);
  if (body.psiConcurrency) args['psi-concurrency'] = String(body.psiConcurrency);
  if (body.trendWeeks) args['trend-weeks'] = String(body.trendWeeks);
  if (body.noTrend) args['no-trend'] = true;

  if (body.mode === 'sitemap') args.sitemap = body.value;
  else if (body.mode === 'sitemap-index') args['sitemap-index'] = body.value;
  else args.url = body.value;          // a typed URL, a paste, or a file's text

  const cfg = buildConfig(args);

  // A file keeps its own name in the report's filename; a paste is named after
  // the first host in it, which buildConfig already worked out.
  if (body.filename) {
    cfg.siteLabel = labelFor('file', body.filename);
    cfg.out = `${cfg.cruxScope === 'none' ? 'pagespeed' : 'speed'}-${cfg.siteLabel}-${cfg.out.split('-').slice(-5).join('-')}`;
  }
  if (body.pick) cfg.pick = body.pick;
  return cfg;
}

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
 * Resolve the input and price the run, without spending anything.
 *
 * A sitemap index with nothing picked yet comes back as a child list for the
 * user to tick, which is the GUI's version of the CLI's prompt.
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
      sample: groups[0].urls.slice(0, 5),
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

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
  const send = (event) => res.write(JSON.stringify(event) + '\n');

  send({ type: 'plan', ...estimate(cfg, groups), siteLabel: cfg.siteLabel });

  try {
    const data = await runReport(cfg, groups, send);
    lastRun = { cfg, data };
    send({
      type: 'done',
      counts: ['GOOD', 'NEEDS WORK', 'POOR', 'ERROR'].reduce((acc, v) => {
        acc[v] = data.psiRows.filter((r) => r.verdict === v).length;
        return acc;
      }, {}),
      origins: data.originRows.map((r) => ({
        origin: r.origin, device: r.device, cwv: r.cwv, score: r.score, values: r.values,
      })),
      trendRows: data.trendRows.length,
    });
  } catch (e) {
    send({ type: 'error', message: String(e.message || e) });
  }
  res.end();
}

/** Write the workbook for the run that just finished. */
async function handleExport(body) {
  if (!lastRun) throw new Error('Nothing to export yet — run a test first.');
  const dir = body.dir || defaultOutDir();
  const path = await exportWorkbook(lastRun.cfg, lastRun.data, join(dir, basename(lastRun.cfg.out)));
  lastRun.outPath = path;
  return { ok: true, path };
}

/** Show the finished file in Explorer / Finder / the desktop's file manager. */
function revealFile(path) {
  const [cmd, args] = process.platform === 'win32' ? ['explorer', [`/select,${path}`]]
    : process.platform === 'darwin' ? ['open', ['-R', path]]
    : ['xdg-open', [dirname(path)]];
  // explorer.exe returns 1 even when it works, so the exit code says nothing.
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

      if (path === '/api/check-key') {
        // One cheap real call, so a wrong key fails here and not 40 minutes in.
        const probe = await fetch(
          'https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://example.com&category=performance&key='
          + encodeURIComponent(body.apiKey || (await loadSettings()).apiKey || ''),
          { signal: AbortSignal.timeout(60000) },
        ).catch((e) => ({ ok: false, status: 0, _err: e }));

        if (probe.ok) return json(res, 200, { ok: true });
        const detail = probe._err
          ? String(probe._err.cause?.message || probe._err.message)
          : ((await probe.json().catch(() => ({}))).error || {}).message || `HTTP ${probe.status}`;
        return json(res, 200, { ok: false, status: probe.status, detail });
      }

      if (path === '/api/resolve') return json(res, 200, await handleResolve(body));
      if (path === '/api/run') return await handleRun(body, res);
      if (path === '/api/export') return json(res, 200, await handleExport(body));

      if (path === '/api/reveal') {
        if (!lastRun || !lastRun.outPath) throw new Error('No file to show yet.');
        revealFile(lastRun.outPath);
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
      console.log('Page speed report  —  ' + target);
      console.log('Close this window to quit.');
      if (open) openBrowser(target);
      ok({ server, url: target, token: TOKEN });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  start({ port: Number(process.env.PORT) || 0, open: !process.argv.includes('--no-open') })
    .catch((e) => {
      console.error(String(e.message || e));
      process.exit(1);
    });
}
