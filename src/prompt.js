import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const fmt = (n) => n.toLocaleString('en-US');

/**
 * Ask which sitemaps from an index to test.
 *
 * Accepts "1", "1,3", "2-4", "1,3-5", "a"/"all", or empty for all. A leading
 * word is tolerated because people type what the prompt shows them ("pick 1,3").
 *
 * Output here is English on purpose: Windows terminals render right-to-left text
 * character-by-character and reversed, which makes Persian unreadable exactly
 * where the user has to make a choice.
 */
export async function pickSitemaps(children, { preset = null } = {}) {
  const usable = children.filter((c) => c.xml && c.count > 0);
  const broken = children.filter((c) => !c.xml || c.count === 0);

  if (!usable.length) {
    const why = broken.map((c) => `  - ${c.name}: ${c.error || (c.nested ? 'nested sitemap' : 'empty')}`).join('\n');
    throw new Error(`None of the sitemaps in this index could be used:\n${why}`);
  }

  const total = usable.reduce((s, c) => s + c.count, 0);

  const parse = (answer) => {
    // "pick 1,3" / "select 2-4" — drop a leading word, keep the selection
    const raw = String(answer).trim().toLowerCase().replace(/^[a-z]+\s+(?=[\d,\s-])/, '');
    if (!raw || raw === 'a' || raw === 'all') return usable;

    const picked = new Set();
    for (const part of raw.split(/[,\s]+/)) {
      const chunk = part.trim();
      if (!chunk) continue;
      const range = chunk.match(/^(\d+)\s*-\s*(\d+)$/);
      if (range) {
        const from = Number(range[1]), to = Number(range[2]);
        if (from < 1 || to > usable.length || from > to) return null;
        for (let i = from; i <= to; i++) picked.add(i - 1);
        continue;
      }
      if (!/^\d+$/.test(chunk)) return null;
      const n = Number(chunk);
      if (n < 1 || n > usable.length) return null;
      picked.add(n - 1);
    }
    if (!picked.size) return null;
    return [...picked].sort((a, b) => a - b).map((i) => usable[i]);
  };

  // --pick lets scheduled runs skip the prompt entirely
  if (preset !== null && preset !== undefined && String(preset).length) {
    const chosen = parse(preset);
    if (!chosen) throw new Error(`Invalid --pick value "${preset}". Use 1-${usable.length}, a range, or "all".`);
    console.log(`Selected via --pick: ${chosen.map((c) => c.name).join(', ')}`);
    return chosen;
  }

  console.log('');
  console.log(`This index contains ${children.length} sitemaps:`);
  console.log('');
  usable.forEach((c, i) => {
    console.log(`  ${String(i + 1).padStart(2)}) ${c.name.padEnd(30)} ${fmt(c.count).padStart(8)} URLs`);
  });
  broken.forEach((c) => {
    const why = c.error ? c.error.slice(0, 40) : (c.nested ? 'nested sitemap - skipped' : 'empty');
    console.log(`   -) ${c.name.padEnd(30)} ${'-'.padStart(8)}   ${why}`);
  });
  console.log('');
  console.log(`   a) all (${fmt(total)} URLs across ${usable.length} sitemaps)`);
  console.log('');

  if (!stdin.isTTY) {
    throw new Error(
      'No interactive input available. Use --pick to choose non-interactively, e.g. --pick 1,3 or --pick all'
    );
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const answer = await rl.question('Which ones? (e.g. 1,3 or 2-4 or a for all) > ');
      const chosen = parse(answer);
      if (chosen) {
        console.log(`Selected: ${chosen.map((c) => c.name).join(', ')}`);
        console.log('');
        return chosen;
      }
      console.log(`   Invalid. Use a number from 1 to ${usable.length}, a range like 2-4, or "a" for all.`);
    }
  } finally {
    rl.close();
  }
}
