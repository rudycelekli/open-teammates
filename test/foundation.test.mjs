import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createMission, buildDeliverables } from '../src/events.mjs';
import { createStore } from '../src/store.mjs';
import { runMission, reviewDeliverables } from '../src/runtime.mjs';
import { actionDigest, evaluateAction, resolveApproval } from '../src/policy.mjs';
import { modelConfig, callModel, refineDrafts } from '../src/model.mjs';
import { startServer } from '../src/server.mjs';

// All events, preferences, vendors, and providers in this file are fictional.
const missionInput = (overrides = {}) => ({
  name: 'Fictional Builders Forum',
  organization: 'Example Organization',
  objective: 'Participants build one reproducible prototype and choose a next step.',
  audience: 'Developers and technical customer teams',
  format: 'flagship',
  city: 'New York',
  date: '2027-06-18',
  timezone: 'America/New_York',
  budget: 125003,
  currency: 'USD',
  capacity: 300,
  constraints: ['Provide live captions and a step-free attendee journey.'],
  ...overrides,
});
const localEnv = Object.freeze({
  OPEN_TEAMMATES_BASE_URL: 'http://localhost:12345/v1',
  OPEN_TEAMMATES_MODEL: 'fictional-test-model',
});
const fictionalRole = {
  foundation: 'Be truthful about uncertainty.',
  soul: 'Act as a thoughtful Chief of Events.',
  instructions: 'Create drafts for owner review.',
  skill: 'Protect attendee access and reconcile the budget.',
};

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'open-teammates-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: await createStore(directory) };
}

function providerResponse(content, { status = 200, finishReason = 'stop' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify({
      choices: [{ finish_reason: finishReason, message: { content } }],
      usage: { prompt_tokens: 30, completion_tokens: 50 },
    }),
  };
}

function completeDocumentResponse(artifacts) {
  return {
    documents: artifacts.filter(item => item.name.endsWith('.md')).map(item => ({
      name: item.name,
      content: `# Draft: ${item.title}\n\n${'This fictional plan remains a proposal. Verify assumptions, current supplier quotes, attendee access, and accountable owners before delivery. '.repeat(2)}`,
    })),
    reflection: 'Confirm audience needs, product readiness, current quotes, and named owners.',
  };
}

// Small parser handles quoted commas, escaped quotes, and record terminators.
function parseCsv(text) {
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { value += '"'; index++; }
      else quoted = !quoted;
    } else if (!quoted && character === ',') { row.push(value); value = ''; }
    else if (!quoted && (character === '\r' || character === '\n')) {
      if (character === '\r' && text[index + 1] === '\n') index++;
      row.push(value); rows.push(row); row = []; value = '';
    } else value += character;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}

function localRequest(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const connection = request(url, { method, headers, agent: false }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text, data: JSON.parse(text) }));
      response.on('error', reject);
    });
    connection.on('error', reject);
    connection.end(body);
  });
}

test('missions, drafts, owner preferences, decisions, and audit survive reopening', async t => {
  const { directory, store } = await workspace(t);
  const mission = await store.addMission(missionInput());
  const memory = await store.addMemory('Prefer practical build labs over long speeches.');
  const drafted = await runMission(store, mission.id);
  const proposed = await store.requestAction({
    kind: 'send_message',
    summary: 'Review a fictional invitation for a venue quote',
    missionId: mission.id,
    payload: { to: 'venue@example.invalid', subject: 'Draft availability inquiry', body: 'Please review this proposed inquiry before sending.' },
  });
  const approved = await store.decideAction(proposed.id, 'approve');
  await store.record('test.reviewed', { missionId: mission.id });

  const reopened = await createStore(directory);
  const snapshot = reopened.snapshot();
  assert.equal(reopened.root, directory);
  assert.equal(snapshot.missions.length, 1);
  assert.equal(snapshot.memory[0].id, memory.id);
  assert.equal(snapshot.memory[0].source, 'owner');
  assert.equal(snapshot.memory[0].status, 'confirmed');
  assert.equal(snapshot.approvals[0].status, 'approved_for_handoff');
  assert.equal(snapshot.approvals[0].digest, approved.digest);
  assert.equal(snapshot.approvals[0].executed, false);
  assert.equal(reopened.getMission(mission.id).mode, 'template');
  assert.equal(reopened.getMission(mission.id).runs.length, 1);
  assert.ok(snapshot.audit.some(item => item.type === 'test.reviewed'));
  assert.ok(snapshot.audit.some(item => item.type === 'handoff.decided' && item.executed === false));
  for (const artifact of drafted.artifacts) {
    assert.equal(await readFile(artifact.path, 'utf8'), artifact.content);
  }

  // Read APIs return detached data and cannot silently change persisted state.
  snapshot.missions[0].name = 'Changed outside the store';
  snapshot.memory[0].text = 'Changed outside the store';
  const detached = reopened.getMission(mission.id);
  detached.budget = 1;
  assert.equal(reopened.getMission(mission.id).name, mission.name);
  assert.equal(reopened.getMission(mission.id).budget, mission.budget);
  assert.equal(reopened.snapshot().memory[0].text, memory.text);
});

test('confirmed preferences can be removed and concurrent writes remain durable', async t => {
  const { directory, store } = await workspace(t);
  const memories = await Promise.all([
    store.addMemory('Use concise executive decision briefs.'),
    store.addMemory('Offer a useful remote participation path.'),
    store.addMemory('Prefer small-group networking with opt-in follow-up.'),
  ]);
  await store.deleteMemory(memories[1].id);
  const snapshot = (await createStore(directory)).snapshot();
  assert.deepEqual(snapshot.memory.map(item => item.id), [memories[0].id, memories[2].id]);
  assert.ok(snapshot.audit.some(item => item.type === 'memory.deleted' && item.memoryId === memories[1].id));
  await assert.rejects(store.deleteMemory(memories[1].id), /Memory not found/);
  await assert.rejects(store.addMemory('x'), /Memory needs/);
  assert.equal(store.snapshot().memory.length, 2);
});

test('approval digest rejects any change to the exact proposed handoff', async t => {
  const original = evaluateAction({
    kind: 'spend', summary: 'Proposed caption service', missionId: 'fictional-mission',
    payload: { amountMinor: 275000, currency: 'USD', vendor: 'Fictional Caption Vendor' },
  });
  original.digest = actionDigest(original);
  const changes = {
    kind: action => { action.kind = 'sign_contract'; },
    summary: action => { action.summary = 'Proposed caption service and interpretation'; },
    payload: action => { action.payload.amountMinor += 1; },
    mission: action => { action.missionId = 'different-fictional-mission'; },
  };
  for (const [name, mutate] of Object.entries(changes)) {
    await t.test(name, () => {
      const modified = structuredClone(original);
      mutate(modified);
      assert.notEqual(actionDigest(modified), original.digest);
      assert.throws(() => resolveApproval(modified, 'approve'), /changed since it was proposed/);
      assert.throws(() => resolveApproval(modified, 'reject'), /changed since it was proposed/);
    });
  }
  const approved = resolveApproval(original, 'approve');
  assert.equal(approved.status, 'approved_for_handoff');
  assert.equal(approved.executed, false);
  assert.equal(original.status, 'pending');
});

test('decided handoffs cannot be replayed, including after reopening', async t => {
  const { directory, store } = await workspace(t);
  for (const decision of ['approve', 'reject']) {
    const action = await store.requestAction({
      kind: 'publish', summary: 'Review a fictional event announcement',
      payload: { channel: 'example website', body: 'Draft announcement. Venue and speakers unconfirmed.' },
    });
    const resolved = await store.decideAction(action.id, decision);
    assert.equal(resolved.executed, false);
    await assert.rejects(store.decideAction(action.id, decision), /already been decided/);
    await assert.rejects(store.decideAction(action.id, decision === 'approve' ? 'reject' : 'approve'), /already been decided/);
    await assert.rejects((await createStore(directory)).decideAction(action.id, decision), /already been decided/);
  }
  assert.equal(store.snapshot().audit.filter(item => item.type === 'handoff.decided').length, 2);
});

test('reopened store rejects a persisted proposal changed after its digest was saved', async t => {
  const { directory, store } = await workspace(t);
  const proposed = await store.requestAction({
    kind: 'share_attendee_data', summary: 'Review minimal fictional agency data',
    payload: { fields: ['attendee count'], purpose: 'Room capacity planning' },
  });
  const stateFile = join(directory, 'state.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  state.approvals[0].payload.fields.push('private phone number');
  await writeFile(stateFile, JSON.stringify(state));
  const reopened = await createStore(directory);
  await assert.rejects(reopened.decideAction(proposed.id, 'approve'), /changed since it was proposed/);
  assert.equal(reopened.snapshot().approvals[0].status, 'pending');
  assert.equal(reopened.snapshot().audit.filter(item => item.type === 'handoff.decided').length, 0);
});

test('unsupported actions and non-concrete spending proposals are rejected', () => {
  assert.throws(() => evaluateAction({ kind: 'run_shell', summary: 'Execute anything', payload: {} }), /Unsupported action/);
  assert.throws(() => evaluateAction({ kind: 'spend', summary: 'Missing amount', payload: {} }), /Spending requests/);
  assert.throws(() => evaluateAction({ kind: 'spend', summary: 'Fractional minor units', payload: { amountMinor: 1.5, currency: 'USD' } }), /Spending requests/);
  assert.throws(() => evaluateAction({ kind: 'spend', summary: 'Negative amount', payload: { amountMinor: -1, currency: 'USD' } }), /Spending requests/);
  assert.throws(() => evaluateAction({ kind: 'spend', summary: 'Invalid currency', payload: { amountMinor: 100, currency: 'dollars' } }), /Spending requests/);
  assert.throws(() => evaluateAction({ kind: 'send_message', summary: 'Payload is a string', payload: 'send this' }), /concrete payload/);
});

test('offline budget allocations reconcile exactly across formats and cap boundaries', async t => {
  for (const format of ['flagship', 'executive', 'regional', 'internal', 'webinar']) {
    for (const cap of [1, 101, 4999, 180000, Number.MAX_SAFE_INTEGER]) {
      await t.test(`${format}: ${cap}`, () => {
        const mission = createMission(missionInput({ format, budget: cap }), new Date('2026-10-07T16:00:00Z'));
        const artifacts = buildDeliverables(mission);
        const budget = parseCsv(artifacts.find(item => item.name === 'budget.csv').content);
        const amountColumn = budget[0].indexOf('Allocated amount (major units)');
        const currencyColumn = budget[0].indexOf('Currency');
        assert.ok(amountColumn >= 0);
        const rows = budget.slice(1);
        const total = rows.find(row => row[0] === 'TOTAL');
        const allocations = rows.filter(row => row[0] !== 'TOTAL');
        assert.equal(BigInt(total[amountColumn]), BigInt(cap));
        assert.equal(allocations.reduce((sum, row) => sum + BigInt(row[amountColumn]), 0n), BigInt(cap));
        assert.ok(allocations.every(row => /^\d+$/.test(row[amountColumn]) && row[currencyColumn] === 'USD'));
        assert.ok(allocations.some(row => row[0] === 'Accessibility and inclusion'));
        assert.ok(allocations.some(row => row[0] === 'Contingency reserve'));
        assert.equal(reviewDeliverables(artifacts).passed, true);
        assert.match(artifacts.find(item => item.name === 'event-brief.md').content, /planning proposal/i);
      });
    }
  }
});

test('offline preference artifact accurately distinguishes recorded context from reasoning', async t => {
  const { store } = await workspace(t);
  const mission = await store.addMission(missionInput());
  await store.addMemory('No direct messages may be sent without review.');
  const drafted = await runMission(store, mission.id, {
    fetchImpl: () => { throw new Error('Offline mode must not contact a provider.'); },
  });
  const preferences = drafted.artifacts.find(item => item.name === 'owner-preferences.md');
  assert.match(preferences.content, /No direct messages may be sent without review/);
  assert.match(preferences.content, /offline templates do not reason over these preferences/);
  assert.match(preferences.content, /preferences cannot grant tool permissions/);
  assert.equal(drafted.mode, 'template');
  assert.match(drafted.review.scope, /Structural checks only/);
});

test('a mocked live draft uses mission and preferences, preserves CSVs, and saves once', async t => {
  const { store } = await workspace(t);
  const mission = await store.addMission(missionInput());
  await store.addMemory('Keep executive briefs concise and supply accessible alternatives.');
  const originals = buildDeliverables(mission);
  const data = completeDocumentResponse(originals);
  let calls = 0;
  const drafted = await runMission(store, mission.id, {
    live: true, env: localEnv,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'http://localhost:12345/v1/chat/completions');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, undefined);
      const request = JSON.parse(options.body);
      const context = JSON.parse(request.messages[1].content);
      assert.equal(context.mission.id, mission.id);
      assert.equal(context.mission.budget, mission.budget);
      assert.deepEqual(context.ownerPreferences, ['Keep executive briefs concise and supply accessible alternatives.']);
      assert.equal(request.response_format.type, 'json_object');
      return providerResponse(JSON.stringify(data));
    },
  });
  assert.equal(calls, 1);
  assert.equal(drafted.mode, 'live');
  assert.equal(drafted.runs.length, 1);
  assert.equal(drafted.review.generation.model, 'fictional-test-model');
  assert.deepEqual(drafted.review.generation.usage, { prompt_tokens: 30, completion_tokens: 50 });
  for (const original of originals.filter(item => item.name.endsWith('.csv'))) {
    assert.equal(drafted.artifacts.find(item => item.name === original.name).content, original.content);
  }
  assert.ok(drafted.artifacts.filter(item => item.name.endsWith('.md') && item.name !== 'owner-preferences.md').every(item => item.content.startsWith('> Draft: model-generated proposal.')));
  assert.match(drafted.artifacts.find(item => item.name === 'owner-preferences.md').content, /Included in the live drafting request/);
});

test('invalid live draft contracts cannot replace an existing saved run', async t => {
  const cases = {
    'not JSON': () => 'I have booked the event.',
    'missing document': data => { data.documents.pop(); return JSON.stringify(data); },
    'duplicate document': data => { data.documents[1].name = data.documents[0].name; return JSON.stringify(data); },
    'unknown document': data => { data.documents[0].name = 'invented-document.md'; return JSON.stringify(data); },
    'CSV replacement': data => { data.documents[0].name = 'budget.csv'; return JSON.stringify(data); },
    'short document': data => { data.documents[0].content = '# Draft'; return JSON.stringify(data); },
    'missing reflection': data => { data.reflection = ''; return JSON.stringify(data); },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    await t.test(name, async t => {
      const { directory, store } = await workspace(t);
      const mission = await store.addMission(missionInput());
      await runMission(store, mission.id);
      const before = store.getMission(mission.id);
      const content = mutate(completeDocumentResponse(buildDeliverables(mission)));
      await assert.rejects(runMission(store, mission.id, {
        live: true, env: localEnv,
        fetchImpl: async () => providerResponse(content),
      }), /JSON draft contract|complete documents|document name or content/);
      assert.deepEqual(store.getMission(mission.id), before);
      assert.deepEqual((await createStore(directory)).getMission(mission.id), before);
      assert.equal(store.snapshot().audit.filter(item => item.type === 'mission.drafted').length, 1);
    });
  }
});

test('provider truncation and HTTP failures reject drafts without exposing provider error bodies', async t => {
  const mission = createMission(missionInput());
  const artifacts = buildDeliverables(mission);
  await assert.rejects(refineDrafts({
    role: fictionalRole, mission, memory: [], artifacts, env: localEnv,
    fetchImpl: async () => providerResponse(JSON.stringify(completeDocumentResponse(artifacts)), { finishReason: 'length' }),
  }), /truncated/);

  const secret = 'fictional-secret-do-not-print';
  await assert.rejects(callModel({
    role: fictionalRole, mission, message: 'Draft a brief.',
    env: { ...localEnv, OPEN_TEAMMATES_API_KEY: secret },
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, `Bearer ${secret}`);
      return { ok: false, status: 401, text: async () => `Provider echoed ${secret}` };
    },
  }), error => {
    assert.match(error.message, /HTTP 401/);
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.message.includes('Provider echoed'), false);
    return true;
  });
});

test('failed provider requests preserve the previous pack in memory and on disk', async t => {
  for (const failure of ['http', 'truncated']) {
    await t.test(failure, async t => {
      const { directory, store } = await workspace(t);
      const mission = await store.addMission(missionInput());
      await runMission(store, mission.id);
      const before = store.getMission(mission.id);
      await assert.rejects(runMission(store, mission.id, {
        live: true, env: localEnv,
        fetchImpl: async () => providerResponse(JSON.stringify(completeDocumentResponse(buildDeliverables(mission))), failure === 'http' ? { status: 503 } : { finishReason: 'length' }),
      }), /HTTP 503|truncated/);
      assert.deepEqual(store.getMission(mission.id), before);
      assert.deepEqual((await createStore(directory)).getMission(mission.id), before);
    });
  }
});

test('live mode requires explicit configuration and refuses unsafe provider URLs', async () => {
  assert.equal(modelConfig({}).ready, false);
  assert.equal(modelConfig(localEnv).ready, true);
  assert.equal(modelConfig(localEnv).local, true);
  assert.equal(modelConfig({ OPEN_TEAMMATES_MODEL: 'fictional-test-model' }).ready, false);
  for (const baseUrl of ['http://example.invalid/v1', 'https://name:fictional-secret@example.invalid/v1', 'https://example.invalid/v1?key=fictional-secret', 'https://example.invalid/v1#token']) {
    assert.throws(() => modelConfig({ ...localEnv, OPEN_TEAMMATES_BASE_URL: baseUrl }), error => {
      assert.equal(error.message.includes('fictional-secret'), false);
      return /HTTPS provider URL/.test(error.message);
    });
  }
  let called = false;
  await assert.rejects(callModel({
    role: fictionalRole, mission: null, message: 'Draft a brief.', env: {},
    fetchImpl: async () => { called = true; throw new Error('Unexpected provider call'); },
  }), /No provider request was made/);
  assert.equal(called, false);
});

test('CLI doctor reports configuration without displaying the configured API key', async () => {
  const secret = 'fictional-cli-secret-do-not-print';
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../bin/open-teammates.mjs', import.meta.url)), 'doctor',
  ], { env: { ...localEnv, OPEN_TEAMMATES_API_KEY: secret } });
  assert.equal(stderr, '');
  assert.equal(stdout.includes(secret), false);
  const status = JSON.parse(stdout);
  assert.equal(status.model, 'fictional-test-model');
  assert.equal(status.provider, 'http://localhost:12345/v1');
  assert.equal(status.live, 'configured, connection untested');
  assert.equal(status.published, false);
  assert.equal(Object.hasOwn(status, 'key'), false);
});

test('structural review rejects missing production and measurement exports', () => {
  const artifacts = buildDeliverables(createMission(missionInput()));
  const result = reviewDeliverables(artifacts.filter(item => !['budget.csv', 'measurement-plan.md'].includes(item.name)));
  assert.equal(result.passed, false);
  assert.equal(result.checks.find(check => check.name === 'Budget and production exports present').passed, false);
  assert.equal(result.checks.find(check => check.name === 'Measurements and follow-through present').passed, false);
  assert.match(result.scope, /Event judgment, facts and real-world readiness require owner review/);
});

test('local API requires host, origin, and session checks and never prints provider credentials', async t => {
  const { store } = await workspace(t);
  const secret = 'fictional-server-secret-do-not-print';
  const { server, url } = await startServer(store, {
    port: 0, env: { ...localEnv, OPEN_TEAMMATES_API_KEY: secret },
  });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

  assert.equal((await localRequest(`${url}/api/session`, { headers: { Host: 'attacker.example.invalid' } })).status, 403);
  assert.equal((await localRequest(`${url}/api/session`, { headers: { Origin: 'http://attacker.example.invalid' } })).status, 403);
  assert.equal((await localRequest(`${url}/api/session`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await localRequest(`${url}/api/state`)).status, 401);

  const session = await localRequest(`${url}/api/session`, { headers: { Origin: url } });
  assert.equal(session.status, 200);
  assert.match(session.data.token, /^[a-f0-9]{64}$/);
  const headers = { 'X-Teammates-Token': session.data.token, 'Content-Type': 'application/json', Origin: url };
  assert.equal((await localRequest(`${url}/api/state`, { headers: { 'X-Teammates-Token': 'x'.repeat(64) } })).status, 401);
  assert.equal((await localRequest(`${url}/api/state`, { headers: { ...headers, Origin: 'http://attacker.example.invalid' } })).status, 403);

  const state = await localRequest(`${url}/api/state`, { headers });
  assert.equal(state.status, 200);
  assert.equal(state.data.runtime.mode, 'template');
  assert.equal(state.data.runtime.liveEnabled, false);
  assert.equal(state.data.capabilities.realWorldExecution, false);
  assert.equal(state.data.capabilities.backgroundMonitoring, false);
  assert.equal(state.text.includes(secret), false);
  assert.equal(session.text.includes(secret), false);
  assert.equal(state.headers['cache-control'], 'no-store');
  assert.match(state.headers['content-security-policy'], /frame-ancestors 'none'/);

  const created = await localRequest(`${url}/api/missions`, { method: 'POST', headers, body: JSON.stringify(missionInput()) });
  assert.equal(created.status, 201);
  const blockedLive = await localRequest(`${url}/api/missions/${created.data.id}/run`, { method: 'POST', headers, body: JSON.stringify({ mode: 'live' }) });
  assert.equal(blockedLive.status, 409);
  assert.equal(blockedLive.text.includes(secret), false);
  assert.equal(store.getMission(created.data.id).runs.length, 0);
  const drafted = await localRequest(`${url}/api/missions/${created.data.id}/run`, { method: 'POST', headers, body: JSON.stringify({ mode: 'template' }) });
  assert.equal(drafted.status, 200);
  assert.equal(drafted.data.mode, 'template');
  assert.equal(drafted.data.runs.length, 1);

  const proposed = await localRequest(`${url}/api/actions`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'book_venue', summary: 'Review a fictional venue hold', missionId: created.data.id, payload: { venue: 'Fictional Room', date: '2027-06-18', conditions: 'Quote and accessibility verification pending.' } }),
  });
  assert.equal(proposed.status, 201);
  const approved = await localRequest(`${url}/api/approvals/${proposed.data.id}`, { method: 'POST', headers, body: JSON.stringify({ decision: 'approve' }) });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.status, 'approved_for_handoff');
  assert.equal(approved.data.executed, false);
  const replayed = await localRequest(`${url}/api/approvals/${proposed.data.id}`, { method: 'POST', headers, body: JSON.stringify({ decision: 'approve' }) });
  assert.equal(replayed.status, 400);
  assert.match(replayed.data.error, /already been decided/);
});
