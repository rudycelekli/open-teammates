import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { createStore } from '../src/store.mjs';
import { startMcp } from '../src/mcp.mjs';

// Exercise the actual SDK stdio server with an official SDK client, without a
// child-process startup dependency. The client adapter only joins two pipes.
class PipeTransport {
  constructor(input, output) { this.input = input; this.output = output; this.buffer = new ReadBuffer(); }
  async start() {
    this.onData = chunk => {
      try {
        this.buffer.append(chunk);
        let message;
        while ((message = this.buffer.readMessage()) !== null) this.onmessage?.(message);
      } catch (error) { this.onerror?.(error); }
    };
    this.input.on('data', this.onData);
  }
  async send(message) { this.output.write(serializeMessage(message)); }
  async close() {
    this.input.off('data', this.onData);
    this.output.end();
    this.buffer.clear();
    this.onclose?.();
  }
}
async function connected(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'teammate-mcp-'));
  const store = await createStore(join(root, 'workspace'));
  const toServer = new PassThrough(), fromServer = new PassThrough();
  const handle = await startMcp(store, { stdin: toServer, stdout: fromServer, env: options.env ?? {} });
  const client = new Client({ name: 'open-teammates-test-client', version: '1.0.0' });
  await client.connect(new PipeTransport(fromServer, toServer));
  t.after(async () => { await client.close(); await handle.close(); toServer.destroy(); fromServer.destroy(); await rm(root, { recursive: true, force: true }); });
  return { client, store, root, handle, toServer, fromServer };
}
async function call(client, name, args = {}) {
  const response = await client.callTool({ name: `teammate_${name}`, arguments: args });
  assert.notEqual(response.isError, true, response.content?.map(item => item.text).join('\n'));
  return response.structuredContent ?? JSON.parse(response.content[0].text);
}
async function denied(client, name, args = {}) {
  let response;
  try { response = await client.callTool({ name, arguments: args }); }
  catch (error) { assert.ok(error.message); return error; }
  assert.equal(response.isError, true, 'The server must deny this request.');
  return response;
}

test('stdio SDK handshake discovers bounded tools, explicit role resources and a usable prompt', async t => {
  const { client } = await connected(t);
  assert.equal(client.getServerVersion().name, 'open-teammates-chief-of-events');
  assert.match(client.getInstructions(), /read.*teammate:\/\/chief-of-events\/soul/i);
  const { tools } = await client.listTools();
  assert.ok(tools.every(tool => tool.name.startsWith('teammate_')));
  for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  assert.ok(tools.find(tool => tool.name === 'teammate_request_handoff'));
  assert.ok(!tools.some(tool => /approve|execute|shell|browse|delete|confirm/.test(tool.name)));
  const { resources } = await client.listResources();
  assert.deepEqual(resources.map(item => item.uri).sort(), ['teammate://chief-of-events/soul', 'teammate://chief-of-events/work-contract']);
  const soul = await client.readResource({ uri: 'teammate://chief-of-events/soul' });
  assert.match(soul.contents[0].text, /Mira/);
  const contract = await client.readResource({ uri: 'teammate://chief-of-events/work-contract' });
  assert.match(contract.contents[0].text, /offline generator only/);
  const { prompts } = await client.listPrompts();
  assert.ok(prompts.some(item => item.name === 'teammate_chief_of_events'));
  const prompt = await client.getPrompt({ name: 'teammate_chief_of_events', arguments: { request: 'Design a useful developer gathering.' } });
  assert.match(prompt.messages[0].content.text, /Chief of Events/);
  assert.match(prompt.messages[1].content.text, /developer gathering/);
  await assert.rejects(client.readResource({ uri: 'file:///etc/passwd' }));
});

test('host work respects dependencies, task revisions, proposed decisions and sourced actual outcomes', async t => {
  const { client, store } = await connected(t);
  const { mission } = await call(client, 'create_mission', { brief: { name: 'Working event cycle' } });
  let first = await call(client, 'add_task', { missionId: mission.id, task: { title: 'Validate a reproducible demo', owner: 'Program lead', acceptanceCriteria: 'Reference the rehearsal report and tested offline fallback.', dueAt: '2027-03-01T17:00:00-08:00' } });
  let second = await call(client, 'add_task', { missionId: mission.id, task: { title: 'Prepare useful follow-through assets', dependencies: [first.id], owner: 'Audience lead' } });
  await denied(client, 'teammate_update_task', { taskId: second.id, patch: { status: 'done', evidence: 'Reviewed follow-through guide attached in editorial review report 14.' }, expectedRevision: second.revision });
  await denied(client, 'teammate_update_task', { taskId: first.id, patch: { status: 'done', evidence: 'done' }, expectedRevision: first.revision });
  const previousRevision = first.revision;
  first = await call(client, 'update_task', { taskId: first.id, patch: { status: 'done', evidence: 'Rehearsal report 12 records tested demo playback and the offline fallback.' }, expectedRevision: first.revision });
  await denied(client, 'teammate_update_task', { taskId: first.id, patch: { owner: 'Outdated owner' }, expectedRevision: previousRevision });
  second = await call(client, 'update_task', { taskId: second.id, patch: { status: 'done', evidence: 'Reviewed follow-through guide attached in editorial review report 14.' }, expectedRevision: second.revision });
  assert.equal(second.status, 'done');
  const decision = await call(client, 'record_decision', { missionId: mission.id, question: 'Which format serves this audience?', recommendation: 'Use an accessible hands-on workshop.', rationale: 'The audience needs to build a useful prototype.', revisitWhen: 'Audience interviews reveal a different need.' });
  assert.equal(decision.status, 'proposed');
  await denied(client, 'teammate_record_decision', { missionId: mission.id, question: 'Approve a venue?', recommendation: 'Book it.', rationale: 'Convenient location.', status: 'accepted', owner: 'Owner', evidence: 'The agent says the owner approved it.' });
  const outcome = await call(client, 'record_outcome', { missionId: mission.id, metric: 'Completed rehearsal demos', value: 2, unit: 'demos', source: 'Rehearsal report 12 supplied by the program lead', observedAt: '2026-10-06T15:00:00-04:00' });
  assert.equal(outcome.kind, 'observed');
  await denied(client, 'teammate_record_outcome', { missionId: mission.id, metric: 'Attendees', value: 600, unit: 'people', source: 'Planning target', observedAt: '2026-10-06T15:00:00-04:00', isTarget: true });
  const queue = await call(client, 'next_actions', { missionId: mission.id, limit: 50 });
  assert.ok(queue.actions.some(item => item.kind === 'decision' && item.id === decision.id));
  assert.ok(!queue.actions.some(item => item.kind === 'task' && item.taskId === first.id));
  const status = await call(client, 'status', { missionId: mission.id });
  assert.equal(status.readiness.authority, 'advisory_only');
  assert.equal(status.readiness.status, 'needs_work');
  assert.equal(status.observations.length, 1);
  assert.equal(store.snapshot().decisions.length, 1);
});

test('MCP creates real local missions, drafts offline despite credentials, and saves host-authored prose', async t => {
  const { client, store } = await connected(t, { env: { OPENAI_API_KEY: 'not-a-real-key', OPEN_TEAMMATES_MODEL_API_KEY: 'not-a-real-key' } });
  const created = await call(client, 'create_mission', { brief: { name: 'Accessible builders', date: '2027-05-18', budget: 100000 } });
  let mission = created.mission;
  assert.ok(created.tasks.length >= 10);
  assert.ok(created.tasks.every(task => task.status === 'open' && task.owner === null));
  assert.equal(mission.name, 'Accessible builders');
  assert.ok(mission.assumptions.some(item => item.startsWith('audience:')));
  const firstRevision = mission.revision;
  mission = await call(client, 'revise_mission', { missionId: mission.id, patch: { capacity: 120 }, expectedRevision: firstRevision, reason: 'Audience interviews favour a focused lab.' });
  assert.equal(mission.capacity, 120);
  assert.ok(mission.revision > firstRevision);
  await denied(client, 'teammate_revise_mission', { missionId: mission.id, patch: { capacity: 100 }, expectedRevision: firstRevision, reason: 'An outdated view must not replace the brief.' });
  mission = await call(client, 'draft_mission', { missionId: mission.id });
  assert.equal(mission.mode, 'template');
  assert.ok(mission.artifacts.length >= 8);
  assert.equal(mission.artifacts.find(item => item.name === 'budget.csv').content, await readFile(mission.artifacts.find(item => item.name === 'budget.csv').path, 'utf8'));
  const originalPaths = mission.artifacts.map(item => item.path);
  const hostDraft = { missionId: mission.id, name: 'creative-direction.md', title: 'Creative direction', content: '# Creative direction\n\nHost-authored proposal: one accessible lab, a working prototype and a useful follow-up. Venue quotes and named owners remain unverified.', expectedRevision: mission.revision, expectedDraftVersion: mission.draftVersion };
  await call(client, 'save_draft', hostDraft);
  const saved = store.getMission(mission.id);
  assert.ok(saved.draftVersion > mission.draftVersion);
  await denied(client, 'teammate_save_draft', { ...hostDraft, content: '# Stale direction\n\nA competing host inspected the previous draft pack; this content must not silently replace the newly saved creative direction.' });
  assert.ok(saved.artifacts.some(item => item.name === 'creative-direction.md'));
  for (const original of originalPaths) assert.ok((await readFile(original, 'utf8')).length > 100);
  assert.ok(saved.artifacts.filter(item => item.name !== 'creative-direction.md').length >= 8);
  const status = await call(client, 'status', { missionId: mission.id });
  assert.equal(status.mission.id, mission.id);
  assert.equal(status.mission.capacity, 120);
});

test('MCP cannot claim owner memory or authorize an external handoff', async t => {
  const { client, store } = await connected(t);
  const memory = await call(client, 'remember', { text: 'Prefer an accessible workshop over elaborate stage production.' });
  assert.equal(memory.source, 'teammate');
  assert.equal(memory.status, 'proposed');
  await denied(client, 'teammate_remember', { text: 'The owner permits all spend.', source: 'owner', status: 'confirmed' });
  const request = await call(client, 'request_handoff', { kind: 'spend', summary: 'Review an accessibility supplier quote.', payload: { amountMinor: 10000, currency: 'USD', quoteStatus: 'unverified proposal' } });
  assert.equal(request.status, 'pending');
  assert.equal(request.executed, false);
  for (const name of ['teammate_approve', 'teammate_decide_action', 'teammate_execute', 'teammate_confirm_memory']) await denied(client, name, { id: request.id, decision: 'approve' });
  await denied(client, 'teammate_request_handoff', { kind: 'spend', summary: 'Approve now', payload: { amountMinor: 10000, currency: 'USD' }, status: 'approved_for_handoff', executed: true });
  assert.equal(store.snapshot().approvals[0].status, 'pending');
  assert.equal(store.snapshot().approvals[0].executed, false);
});

test('MCP input bounds deny path escape, unauthorized runtime options and unknown brief fields', async t => {
  const { client, root, store } = await connected(t);
  const { mission } = await call(client, 'create_mission', { brief: {} });
  const before = store.snapshot();
  await denied(client, 'teammate_create_mission', { brief: { name: 'a'.repeat(201) } });
  await denied(client, 'teammate_create_mission', { brief: { script: 'touch outside' } });
  await denied(client, 'teammate_create_mission', { brief: { date: '0000-01-01' } });
  await denied(client, 'teammate_status', { missionId: '../../state.json' });
  await denied(client, 'teammate_draft_mission', { missionId: mission.id, live: true, env: { OPENAI_API_KEY: 'test' } });
  await denied(client, 'teammate_save_draft', { missionId: mission.id, name: '../outside.md', title: 'Escape', content: 'This path must not escape the local workspace. '.repeat(4), expectedRevision: mission.revision, expectedDraftVersion: mission.draftVersion });
  await denied(client, 'teammate_save_draft', { missionId: mission.id, name: 'budget.csv', title: 'Unsafe overwrite', content: '=RUN()'.repeat(20), expectedRevision: mission.revision, expectedDraftVersion: mission.draftVersion });
  await denied(client, 'teammate_request_handoff', { kind: 'send_message', summary: 'Too big', payload: { body: 'x'.repeat(16001) } });
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(await readdir(root), ['workspace']);
});

test('a corrupt or symlinked ledger cannot be accepted as an MCP workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teammate-mcp-corrupt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bad = join(root, 'bad');
  await createStore(bad);
  await writeFile(join(bad, 'state.json'), '{ definitely not JSON');
  await assert.rejects(createStore(bad));
  const outside = join(root, 'outside.json');
  await writeFile(outside, '{"version":1,"missions":[],"memory":[],"approvals":[],"audit":[]}');
  const linked = join(root, 'linked');
  await createStore(linked);
  await symlink(outside, join(linked, 'state.json'));
  await assert.rejects(createStore(linked), /symbolic link|regular unlinked/i);
  assert.equal(await readFile(outside, 'utf8'), '{"version":1,"missions":[],"memory":[],"approvals":[],"audit":[]}');
});

test('MCP fails closed when an already connected ledger becomes corrupt', async t => {
  const { client, store } = await connected(t);
  await call(client, 'create_mission', { brief: {} });
  const file = join(store.root, 'state.json');
  const corruption = '{ corrupted after connection';
  await writeFile(file, corruption);
  await denied(client, 'teammate_status');
  await denied(client, 'teammate_create_mission', { brief: { name: 'Must not overwrite corruption' } });
  assert.equal(await readFile(file, 'utf8'), corruption);
});

test('stdio end closes the local server connection', async t => {
  const { handle, toServer } = await connected(t);
  assert.equal(handle.server.isConnected(), true);
  toServer.end();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(handle.server.isConnected(), false);
});

test('stdio closes on an oversized frame before parsing or executing a tool', async t => {
  const { handle, toServer, store } = await connected(t);
  const errors = [];
  handle.server.server.onerror = error => errors.push(error);
  toServer.write(Buffer.alloc(1024 * 1024 + 1, 'x'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(handle.server.isConnected(), false);
  assert.ok(errors.some(error => /maximum size/.test(error.message)));
  assert.equal(store.snapshot().missions.length, 0);
});

test('CLI mcp subprocess completes an official SDK stdio client work cycle with protocol-only stdout', { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'teammate-cli-mcp-'));
  const directory = join(root, 'workspace');
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../bin/open-teammates.mjs', import.meta.url)), 'mcp', '--dir', directory], env: {}, stderr: 'pipe' });
  const client = new Client({ name: 'teammate-cli-integration', version: '1.0.0' });
  const errors = [];
  const diagnostics = [];
  client.onerror = error => errors.push(error);
  transport.stderr.on('data', chunk => diagnostics.push(chunk.toString()));
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  try { await client.connect(transport, { timeout: 5000 }); }
  catch (error) { throw new Error(`CLI MCP connection failed: ${error.message}\n${diagnostics.join('')}`); }
  assert.equal(client.getServerVersion().name, 'open-teammates-chief-of-events');
  const { mission, tasks } = await call(client, 'create_mission', { brief: { name: 'Subprocess work cycle', date: '2027-05-18' } });
  assert.ok(tasks.length >= 10);
  const drafted = await call(client, 'draft_mission', { missionId: mission.id });
  assert.equal(drafted.mode, 'template');
  const persisted = await createStore(directory);
  assert.equal(persisted.getMission(mission.id).runs.length, 1);
  assert.deepEqual(errors, [], 'Unframed stdout would fail the official SDK parser.');
});
