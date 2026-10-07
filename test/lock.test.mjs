import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, symlink, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireWorkspaceLock } from '../src/lock.mjs';
import { createStore } from '../src/store.mjs';

const execute = promisify(execFile);
const lockModule = new URL('../src/lock.mjs', import.meta.url).href;
const storeModule = new URL('../src/store.mjs', import.meta.url).href;
const child = (code, args = []) => execute(process.execPath, ['--input-type=module', '--eval', code, ...args], { timeout: 20000, maxBuffer: 1024 * 1024 });

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'open-teammates-lock-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('twelve process contenders recover an exited owner once and retain all critical-section writes', async t => {
  const directory = await workspace(t);
  const lockPath = join(directory, 'exclusive.lock');
  const counterPath = join(directory, 'counter.txt');
  const sentinelPath = join(directory, 'critical-section');
  const ledger = join(directory, 'ledger');
  await writeFile(counterPath, '0');
  const holder = await child(`
    import { acquireWorkspaceLock } from ${JSON.stringify(lockModule)};
    await acquireWorkspaceLock(process.argv[1]);
    process.stdout.write(String(process.pid));
  `, [lockPath]);
  const owner = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.equal(owner.pid, Number(holder.stdout));
  assert.throws(() => process.kill(owner.pid, 0), error => error.code === 'ESRCH');

  const contender = `
    import { open, readFile, writeFile, unlink } from 'node:fs/promises';
    import { acquireWorkspaceLock } from ${JSON.stringify(lockModule)};
    import { createStore } from ${JSON.stringify(storeModule)};
    const [lockPath, counterPath, sentinelPath, ledger, id] = process.argv.slice(1);
    const release = await acquireWorkspaceLock(lockPath, { timeoutMs: 15000 });
    let sentinel;
    try {
      // O_EXCL fails if two processes enter the critical section together.
      sentinel = await open(sentinelPath, 'wx');
      const before = Number(await readFile(counterPath, 'utf8'));
      await new Promise(resolve => setTimeout(resolve, 12));
      const store = await createStore(ledger);
      await store.addMemory('Fictional retained preference from contender ' + id);
      await writeFile(counterPath, String(before + 1));
      process.stdout.write(JSON.stringify({ id, before, after: before + 1 }));
    } finally {
      if (sentinel) { await sentinel.close(); await unlink(sentinelPath); }
      await release();
    }
  `;
  const outputs = await Promise.all(Array.from({ length: 12 }, (_, index) => child(contender, [lockPath, counterPath, sentinelPath, ledger, String(index)])));
  const results = outputs.map(output => JSON.parse(output.stdout));
  assert.equal(await readFile(counterPath, 'utf8'), '12');
  assert.deepEqual(results.map(result => result.before).sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index));
  assert.deepEqual(results.map(result => result.after).sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index + 1));
  const state = (await createStore(ledger)).snapshot();
  assert.equal(state.memory.length, 12);
  assert.equal(new Set(state.memory.map(memory => memory.text)).size, 12);
  assert.equal(state.audit.filter(record => record.type === 'memory.confirmed').length, 12);
  const rootFiles = await readdir(directory);
  assert.ok(!rootFiles.includes('exclusive.lock'));
  assert.ok(!rootFiles.includes('exclusive.lock.recovery'));
  assert.ok(!rootFiles.includes('critical-section'));
  const ledgerFiles = await readdir(ledger);
  assert.ok(!ledgerFiles.includes('.write.lock'));
  assert.ok(!ledgerFiles.includes('.write.lock.recovery'));
});

test('a living owner is never reaped and a competing acquisition times out without changing ownership', async t => {
  const directory = await workspace(t);
  const path = join(directory, 'owner.lock');
  const release = await acquireWorkspaceLock(path);
  try {
    const before = await readFile(path, 'utf8');
    await assert.rejects(acquireWorkspaceLock(path, { timeoutMs: 50 }), /Workspace is busy or has an invalid lock/);
    assert.equal(await readFile(path, 'utf8'), before);
    assert.ok(!(await readdir(directory)).includes('owner.lock.recovery'));
  } finally { await release(); }
  assert.ok(!(await readdir(directory)).includes('owner.lock'));
});

test('symlink and directory lock paths are refused without touching the referenced target', async t => {
  const directory = await workspace(t);
  const outside = join(directory, 'outside.txt');
  await writeFile(outside, 'Original owner-controlled content.');
  const linked = join(directory, 'linked.lock');
  await symlink(outside, linked);
  await assert.rejects(acquireWorkspaceLock(linked, { timeoutMs: 20 }), /regular file/);
  assert.equal(await readFile(outside, 'utf8'), 'Original owner-controlled content.');
  const nonregular = join(directory, 'directory.lock');
  await mkdir(nonregular);
  await assert.rejects(acquireWorkspaceLock(nonregular, { timeoutMs: 20 }), /regular file/);
});

test('invalid owner metadata is preserved for manual review instead of guessed stale', async t => {
  const directory = await workspace(t);
  const path = join(directory, 'invalid.lock');
  const original = '{"pid":"unknown","token":"owner-not-established"}';
  await writeFile(path, original);
  await assert.rejects(acquireWorkspaceLock(path, { timeoutMs: 50 }), /Workspace is busy or has an invalid lock/);
  assert.equal(await readFile(path, 'utf8'), original);
  assert.ok(!(await readdir(directory)).includes('invalid.lock.recovery'));
});
