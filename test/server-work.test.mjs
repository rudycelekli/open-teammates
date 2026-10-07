import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../src/store.mjs';
import { startServer } from '../src/server.mjs';
import { DEMO_BRIEF } from '../src/events.mjs';

const PROOF = 'Jo reviewed the investment rationale and attendee promise in /records/strategy-review.md.';

function localRequest(url, { method = 'GET', token, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(token ? { 'X-Teammates-Token': token } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) };
    const req = request(url, { method, headers }, res => {
      let content = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { content += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(content) }); }
        catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function api(t) {
  const directory = await mkdtemp(join(tmpdir(), 'open-teammates-work-api-'));
  const store = await createStore(directory);
  const { server, url } = await startServer(store, { port: 0, env: {} });
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const { data: { token } } = await localRequest(`${url}/api/session`);
  return { store, send: (path, options = {}) => localRequest(`${url}${path}`, { ...options, token }) };
}

test('mission edits require a real current revision and cannot silently overwrite a newer brief', async t => {
  const { store, send } = await api(t);
  const created = await send('/api/missions', { method: 'POST', body: DEMO_BRIEF });
  assert.equal(created.status, 201);
  const mission = created.data;
  const before = store.snapshot();
  for (const expectedRevision of [undefined, null, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    const response = await send(`/api/missions/${mission.id}/revise`, { method: 'POST', body: { patch: { budget: 90000 }, expectedRevision, reason: 'Finance changed the planning envelope.' } });
    assert.equal(response.status, 400);
    assert.match(response.data.error, /expectedRevision.*positive safe integer/);
    assert.deepEqual(store.snapshot(), before);
  }
  const revised = await send(`/api/missions/${mission.id}/revise`, { method: 'POST', body: { patch: { budget: 90000 }, expectedRevision: mission.revision, reason: 'Finance changed the planning envelope.' } });
  assert.equal(revised.status, 200);
  assert.equal(revised.data.revision, 2);
  const saved = store.snapshot();
  const stale = await send(`/api/missions/${mission.id}/revise`, { method: 'POST', body: { patch: { capacity: 300 }, expectedRevision: 1, reason: 'This edit came from an older browser state.' } });
  assert.equal(stale.status, 400);
  assert.match(stale.data.error, /Revision conflict/);
  assert.deepEqual(store.snapshot(), saved);
});

test('task owner and completion changes require the task revision and prerequisite evidence', async t => {
  const { store, send } = await api(t);
  const created = await send('/api/missions', { method: 'POST', body: DEMO_BRIEF });
  assert.equal(created.status, 201);
  const seeds = store.snapshot().tasks;
  const strategy = seeds.find(item => item.seedKey === 'strategy');
  const finance = seeds.find(item => item.seedKey === 'finance');
  assert.equal(seeds.length, 12);
  for (const expectedRevision of [undefined, null, 0, '1', 1.5]) {
    const response = await send(`/api/tasks/${strategy.id}`, { method: 'POST', body: { patch: { owner: 'Jo' }, expectedRevision } });
    assert.equal(response.status, 400);
    assert.match(response.data.error, /expectedRevision/);
  }
  assert.equal(store.snapshot().tasks.find(item => item.id === strategy.id).owner, null);
  const blocked = await send(`/api/tasks/${finance.id}`, { method: 'POST', body: { patch: { owner: 'Jo', status: 'done', evidence: PROOF }, expectedRevision: 1 } });
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /unmet dependencies/);
  const done = await send(`/api/tasks/${strategy.id}`, { method: 'POST', body: { patch: { owner: 'Jo', status: 'done', evidence: PROOF }, expectedRevision: 1 } });
  assert.equal(done.status, 200);
  assert.equal(done.data.revision, 2);
  assert.equal(done.data.status, 'done');
  const before = store.snapshot();
  const stale = await send(`/api/tasks/${strategy.id}`, { method: 'POST', body: { patch: { owner: 'Sam' }, expectedRevision: 1 } });
  assert.equal(stale.status, 400);
  assert.match(stale.data.error, /Revision conflict/);
  assert.deepEqual(store.snapshot(), before);
});

test('calendar-invalid seeded work cannot leave a partially created mission in the API ledger', async t => {
  const { store, send } = await api(t);
  const before = store.snapshot();
  for (const patch of [{ date: '0000-01-01', timezone: 'UTC' }, { date: '2012-01-06', timezone: 'Pacific/Apia' }]) {
    const rejected = await send('/api/missions', { method: 'POST', body: { ...DEMO_BRIEF, ...patch } });
    assert.equal(rejected.status, 400);
    assert.match(rejected.data.error, /calendar range|does not have a 17:00 deadline/);
    assert.deepEqual(store.snapshot(), before);
  }
  const created = await send('/api/missions', { method: 'POST', body: DEMO_BRIEF });
  assert.equal(created.status, 201);
  const state = await send('/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.data.missions.length, 1);
  assert.equal(state.data.tasks.length, 12);
  assert.ok(state.data.tasks.every(item => item.missionId === created.data.id && item.status === 'open' && item.evidence === null));
});

test('outcome API records explicitly sourced actuals while rejecting proposed targets without mutation', async t => {
  const { store, send } = await api(t);
  const mission = await store.addMission(DEMO_BRIEF);
  const input = { missionId: mission.id, metric: 'Discovery interviews', value: 12, unit: 'interviews', source: 'Reviewed discovery log /records/discovery.csv', observedAt: '2026-10-07T14:00:00Z' };
  const before = store.snapshot();
  const target = await send('/api/outcomes', { method: 'POST', body: { ...input, kind: 'target' } });
  assert.equal(target.status, 400);
  assert.match(target.data.error, /actual result/);
  assert.deepEqual(store.snapshot(), before);
  const actual = await send('/api/outcomes', { method: 'POST', body: input });
  assert.equal(actual.status, 201);
  assert.equal(actual.data.kind, 'observed');
  assert.equal(actual.data.value, 12);
  assert.equal(actual.data.source, input.source);
  assert.equal(store.snapshot().observations.length, 1);
});
