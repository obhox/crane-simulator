#!/usr/bin/env node
// Plain-node test runner (spec §9.6): runs every scripts/test-*.mjs in its own
// node process and reports pass/fail. A test fails by exiting non-zero (throw,
// failed assert, process.exit(1)). `node scripts/run-tests.mjs [filter]`.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] || '';
const files = readdirSync(here).filter((f) => /^test-.*\.mjs$/.test(f) && f.includes(filter)).sort();

if (!files.length) {
  console.log(`no scripts/test-*.mjs${filter ? ` matching "${filter}"` : ''}`);
  process.exit(0);
}

let failed = 0;
const t0 = Date.now();
for (const f of files) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [join(here, f)], { cwd: join(here, '..'), encoding: 'utf8', timeout: 120000 });
  const ok = r.status === 0 && !r.error;
  const ms = Date.now() - t;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${f}  (${ms} ms)`);
  if (!ok) {
    failed++;
    const out = `${r.stdout || ''}${r.stderr || ''}${r.error ? String(r.error) : ''}`.trim();
    if (out) console.log(out.split('\n').map((l) => `      ${l}`).join('\n'));
  } else if (process.env.VERBOSE && r.stdout.trim()) {
    console.log(r.stdout.trim().split('\n').map((l) => `      ${l}`).join('\n'));
  }
}
console.log(`\n${files.length - failed}/${files.length} test files passed in ${Date.now() - t0} ms`);
process.exit(failed ? 1 : 0);
