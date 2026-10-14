#!/usr/bin/env node
import { resolve } from 'node:path';
import { loadEnv, parseArgs, buildConfig, HELP } from './src/config.js';
import { pickSitemaps } from './src/prompt.js';
import { originOf } from './src/crux.js';
import {
  resolveGroups, estimate, runReport, exportWorkbook,
  CRUX_PER_MINUTE, PSI_CROWDING_THRESHOLD,
} from './src/run.js';

let quiet = false;
const say = (...a) => { if (!quiet) console.log(...a); };

/** One re-drawn line per phase, so a long run shows it is alive. */
function bars() {
  const last = new Map();
  return (phase, done, total) => {
    if (quiet) return;
    const pct = Math.floor((done / total) * 100);
    if (last.get(phase) === pct && done !== total) return;
    last.set(phase, pct);
    const bar = '█'.repeat(Math.floor(pct / 5)).padEnd(20, '·');
    process.stdout.write(`\r  ${phase.padEnd(10)} ${bar} ${done}/${total}`);
    if (done === total) process.stdout.write('\n');
  };
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
  const draw = bars();

  const groups = await resolveGroups(
    cfg,
    (e) => {
      if (e.type === 'reading') say(`Reading ${cfg.source}: ${e.what}`);
      if (e.type === 'phase') draw(e.phase, e.done, e.total);
    },
    (children) => pickSitemaps(children, { preset: cfg.pick }),
  );

  const plan = estimate(cfg, groups);

  say('');
  say(`${groups.length} group(s), ${plan.totalUrls} URLs, devices: ${cfg.devices.join(' + ')}`);

  if (plan.capped.length) {
    const dropped = plan.capped.reduce((n, g) => n + (g.of - g.testing), 0);
    say('');
    say(`  !  --max ${cfg.max} left out ${dropped} URLs:`);
    for (const g of plan.capped) say(`       ${g.name}: testing ${g.testing} of ${g.of}`);
    say('       pass --max all to test every URL');
  }

  if (plan.cruxCalls) say(`CrUX: ${plan.cruxCalls} calls (scope=${cfg.cruxScope}, quota ${CRUX_PER_MINUTE}/min)`);
  if (plan.psiCalls) {
    say(`PageSpeed: ${plan.psiCalls} calls, ${plan.psiConcurrency} at a time - roughly ${plan.etaMinutes} min`);
    if (plan.crowding) {
      say(`  !  ${plan.psiConcurrency} parallel runs means ${plan.psiConcurrency} simultaneous crawls of your own`);
      say('     site. Its response time suffers, and the scores come back worse');
      say('     than they would under normal traffic.');
    }
  }
  say('');

  const data = await runReport(cfg, groups, (e) => {
    if (e.type === 'phase') draw(e.phase, e.done, e.total);
  });

  const outPath = await exportWorkbook(cfg, data);

  say('');

  if (data.psiRows.length) {
    const n = (v) => data.psiRows.filter((r) => r.verdict === v).length;
    say(`PageSpeed  -  GOOD ${n('GOOD')}   NEEDS WORK ${n('NEEDS WORK')}   POOR ${n('POOR')}   errors ${n('ERROR')}`);
  }

  for (const r of data.originRows) {
    const host = r.origin.replace(/^https?:\/\//, '');
    say(r.cwv === 'NO DATA'
      ? `Real users  -  ${host} / ${r.device}: no data`
      : `Real users  -  ${host} / ${r.device}: ${r.cwv} (score ${r.score}, LCP ${r.values.LCP ?? '-'}ms)`);
  }

  const nodata = data.cruxRows.filter((r) => r.cwv === 'NO DATA').length;
  if (nodata) say(`(${nodata} pages had no CrUX data - not an error, just too little traffic)`);

  say('');
  console.log(outPath);
}

main().catch((e) => {
  console.error('');
  console.error(String(e.message || e));
  process.exit(1);
});
