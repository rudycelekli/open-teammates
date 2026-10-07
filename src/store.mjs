import { mkdir, writeFile, rename, lstat, rm } from 'node:fs/promises';
import { readFileSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMission, buildDeliverables } from './events.mjs';
import { createTask, seedMissionTasks, validateTaskUpdate, validateDependencies, createDecision, createObservation, nextActions, assessReadiness } from './work.mjs';
import { evaluateAction, actionDigest, resolveApproval } from './policy.mjs';
import { acquireWorkspaceLock } from './lock.mjs';

const collections = ['missions', 'memory', 'approvals', 'audit', 'tasks', 'decisions', 'observations', 'conversations'];
const MAX_STATE_BYTES = 50_000_000;
const empty = () => ({ version: 2, organization: null, ...Object.fromEntries(collections.map(key => [key, []])) });
const validId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const assertId = id => { if (!validId(id)) throw new Error('Record ID must be a UUID.'); };
function migrate(input) {
  if (![1, 2].includes(input?.version) || !['missions', 'memory', 'approvals', 'audit'].every(key => Array.isArray(input[key]))) throw new Error('Unsupported or malformed workspace state.');
  const state = { ...empty(), ...input, version: 2 };
  for (const key of collections) if (!Array.isArray(state[key])) throw new Error(`Malformed ${key} state.`);
  for (const mission of state.missions) {
    if (!validId(mission.id) || !Array.isArray(mission.artifacts) || !Array.isArray(mission.runs)) throw new Error('Malformed mission state.');
    mission.revision ??= 1;
    mission.draftRevision ??= mission.artifacts.length ? mission.revision : null;
    mission.draftVersion ??= mission.runs.length;
    mission.briefHistory ??= [];
    if (!Number.isSafeInteger(mission.revision) || mission.revision < 1) throw new Error('Malformed mission revision.');
    if (!Number.isSafeInteger(mission.draftVersion) || mission.draftVersion < 0) throw new Error('Malformed draft version.');
  }
  for (const key of ['tasks', 'decisions', 'observations', 'conversations']) if (state[key].some(item => !validId(item.id))) throw new Error(`Malformed ${key} IDs.`);
  for (const action of state.approvals) if (input.version === 1 && action.missionId && action.missionRevision === undefined && action.status !== 'rejected') action.status = 'legacy_review_required';
  return state;
}
const stamp = () => new Date().toISOString();
const find = (items, id, name) => { assertId(id); const item = items.find(item => item.id === id); if (!item) throw new Error(`${name} not found.`); return item; };
function checkRevision(record, expected) {
  if (expected !== undefined && expected !== record.revision) throw new Error(`Revision conflict: expected ${expected}, current ${record.revision}. Refresh and review before retrying.`);
}
function validArtifacts(artifacts) {
  return Array.isArray(artifacts) && artifacts.length && artifacts.every(a => a && /^[a-z0-9][a-z0-9-]*\.(md|csv|json)$/.test(a.name) && typeof a.content === 'string' && a.content.length <= 1000000 && typeof a.title === 'string') && new Set(artifacts.map(a => a.name)).size === artifacts.length;
}

export async function createStore(directory) {
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink()) throw new Error('The workspace directory must not be a symbolic link.');
  try { await writeFile(join(root, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const file = join(root, 'state.json');
  function readState() {
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('state.json must be a regular unlinked file.');
      if (stat.size > MAX_STATE_BYTES) throw new Error('Workspace state exceeds 50 MB. Restore or reduce a backed-up copy before continuing.');
      return migrate(JSON.parse(readFileSync(file, 'utf8')));
    } catch (error) { if (error.code !== 'ENOENT') throw error; return empty(); }
  }
  let state = readState();
  let queue = Promise.resolve();
  async function save() {
    const serialized = JSON.stringify(state, null, 2) + '\n';
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STATE_BYTES) throw new Error('Workspace write would exceed 50 MB. The previous committed state was preserved.');
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, serialized, { mode: 0o600, flag: 'wx' });
      await rename(temp, file);
    } finally { await rm(temp, { force: true }).catch(() => {}); }
  }
  function audit(type, details) { state.audit.push({ ...details, id: randomUUID(), type, at: stamp() }); }
  function transaction(fn) {
    const operation = queue.then(async () => {
      const release = await acquireWorkspaceLock(join(root, '.write.lock'));
      try { state = readState(); const result = await fn(); await save(); return structuredClone(result); }
      finally { await release(); }
    });
    queue = operation.catch(() => {});
    return operation;
  }
  const missionById = id => find(state.missions, id, 'Mission');
  const snapshot = () => structuredClone(readState());
  const getMission = id => structuredClone(find(readState().missions, id, 'Mission'));
  async function artifactDirectory(parts) {
    let directory = root;
    for (const part of parts) {
      directory = join(directory, part);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Artifact directories must not be symbolic links.');
    }
    return directory;
  }
  async function savePack(id, artifacts, review, mode, expectedRevision, expectedDraftVersion) {
    const mission = missionById(id);
    checkRevision(mission, expectedRevision);
    if (expectedDraftVersion !== undefined && expectedDraftVersion !== mission.draftVersion) throw new Error(`Draft version conflict: expected ${expectedDraftVersion}, current ${mission.draftVersion}. Refresh before editing another host's work.`);
    if (!validArtifacts(artifacts)) throw new Error('A run must produce unique valid artifacts.');
    const runId = randomUUID();
    const out = await artifactDirectory(['missions', id, runId]);
    for (const artifact of artifacts) await writeFile(join(out, artifact.name), artifact.content, { flag: 'wx', mode: 0o600 });
    mission.artifacts = artifacts.map(item => ({ ...item, path: join(out, item.name) }));
    mission.status = 'draft_ready';
    mission.draftRevision = mission.revision;
    mission.draftVersion++;
    mission.review = review;
    mission.mode = mode;
    mission.runs.push({ id: runId, at: stamp(), mode, revision: mission.revision, review, artifacts: mission.artifacts.map(a => ({ name: a.name, path: a.path })) });
    audit('mission.drafted', { missionId: id, runId, revision: mission.revision, mode, artifacts: artifacts.map(a => a.name), reviewPassed: review.passed });
    return mission;
  }
  return {
    root, snapshot, getMission,
    configureOrganization: input => transaction(() => {
      if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200) throw new Error('Organization needs a name of 1–200 characters.');
      state.organization = { name: input.name.trim(), mission: typeof input.mission === 'string' ? input.mission.slice(0, 2000) : '', at: stamp() };
      audit('organization.configured', {}); return state.organization;
    }),
    addMission: input => transaction(() => {
      const mission = { ...createMission(input), id: randomUUID(), revision: 1, draftRevision: null, draftVersion: 0, artifacts: [], runs: [], briefHistory: [] };
      state.missions.unshift(mission);
      audit('mission.created', { missionId: mission.id, name: mission.name }); return mission;
    }),
    updateMission: (id, patch, { expectedRevision, reason = 'Brief revised by workspace operator.' } = {}) => transaction(() => {
      const mission = missionById(id); checkRevision(mission, expectedRevision);
      const allowed = ['name', 'organization', 'objective', 'audience', 'format', 'city', 'date', 'timezone', 'budget', 'currency', 'capacity', 'constraints'];
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !allowed.includes(key))) throw new Error('Provide only editable brief fields.');
      if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) throw new Error('A revision needs a reason.');
      const previous = Object.fromEntries(allowed.map(key => [key, mission[key]]));
      const assumptions = mission.assumptions.filter(text => !Object.keys(patch).some(key => text.startsWith(`${key}: defaulted`)));
      const normalized = createMission({ ...previous, ...patch, assumptions });
      mission.briefHistory.push({ revision: mission.revision, brief: previous, at: stamp(), reason });
      Object.assign(mission, normalized, { createdAt: mission.createdAt, revision: mission.revision + 1, status: 'needs_redraft', updatedAt: stamp() });
      for (const task of state.tasks.filter(task => task.missionId === id)) {
        task.history ??= []; task.history.push({ revision: task.revision, status: task.status, evidence: task.evidence, dueAt: task.dueAt, at: stamp() });
        task.status = 'blocked'; task.evidence = null; task.revision++;
        task.description = `Brief revision ${mission.revision} requires review of scope, deadline and completion criteria. ${task.description}`;
      }
      for (const decision of state.decisions.filter(d => d.missionId === id && d.status === 'accepted')) { decision.status = 'proposed'; decision.previousAcceptance = decision.evidence; decision.evidence = null; decision.revisitWhen = `Brief changed to revision ${mission.revision}; review the earlier decision.`; }
      for (const action of state.approvals.filter(a => a.missionId === id && ['pending', 'approved_for_handoff'].includes(a.status))) { action.status = 'superseded'; action.reason = 'Mission brief changed; create a new handoff for review.'; }
      audit('mission.revised', { missionId: id, revision: mission.revision, changedFields: Object.keys(patch), reason }); return mission;
    }),
    completeMission: (id, artifacts, review, mode, { expectedRevision, expectedDraftVersion } = {}) => transaction(() => savePack(id, artifacts, review, mode, expectedRevision, expectedDraftVersion)),
    saveDraft: (id, { name, title, content, expectedRevision, expectedDraftVersion } = {}) => transaction(async () => {
      const mission = missionById(id);
      if (!/^[a-z0-9][a-z0-9-]*\.md$/.test(name ?? '') || typeof title !== 'string' || !title.trim() || typeof content !== 'string' || content.length < 100 || content.length > 60000) throw new Error('Host drafts need a Markdown basename, title and 100–60000 characters.');
      checkRevision(mission, expectedRevision);
      const current = mission.draftRevision === mission.revision ? mission.artifacts : buildDeliverables(mission);
      const artifact = { name, title, content: `> Draft: authored by the connected host. Verify facts and commitments before execution.\n\n${content}` };
      const artifacts = [...current.filter(item => item.name !== name), artifact];
      return savePack(id, artifacts, { passed: true, scope: 'Host-authored draft saved; content quality and facts not verified.' }, 'host', expectedRevision, expectedDraftVersion);
    }),
    seedTasks: id => transaction(() => {
      const mission = missionById(id);
      if (state.tasks.some(task => task.missionId === id && task.seedKey)) return state.tasks.filter(task => task.missionId === id && task.seedKey);
      const seeds = seedMissionTasks(mission); const ids = new Map(seeds.map(seed => [seed.key, randomUUID()]));
      const tasks = seeds.map(seed => ({ ...createTask({ ...seed, missionId: id, dependencies: (seed.dependsOnKeys ?? []).map(key => ids.get(key)) }), id: ids.get(seed.key), seedKey: seed.key, revision: 1, createdAt: stamp() }));
      for (const task of tasks) validateDependencies([...state.tasks, ...tasks], task);
      state.tasks.push(...tasks); audit('tasks.seeded', { missionId: id, count: tasks.length }); return tasks;
    }),
    addTask: input => transaction(() => {
      missionById(input?.missionId);
      const task = { ...createTask(input), id: randomUUID(), revision: 1, createdAt: stamp() };
      validateDependencies([...state.tasks, task], task);
      state.tasks.push(task); audit('task.created', { taskId: task.id, missionId: task.missionId }); return task;
    }),
    updateTask: (id, patch, { expectedRevision } = {}) => transaction(() => {
      const task = find(state.tasks, id, 'Task'); checkRevision(task, expectedRevision);
      const normalized = validateTaskUpdate(task, patch, { tasks: state.tasks, now: new Date() });
      validateDependencies(state.tasks.map(item => item.id === id ? { ...normalized, id } : item), { ...normalized, id });
      Object.assign(task, normalized, { revision: task.revision + 1, updatedAt: stamp() });
      audit('task.updated', { taskId: id, missionId: task.missionId, status: task.status }); return task;
    }),
    recordDecision: input => transaction(() => {
      missionById(input?.missionId);
      const decision = { ...createDecision(input), missionId: input.missionId, id: randomUUID(), at: stamp() };
      state.decisions.push(decision); audit('decision.recorded', { decisionId: decision.id, missionId: decision.missionId, status: decision.status }); return decision;
    }),
    addObservation: input => transaction(() => {
      missionById(input?.missionId);
      const observation = { ...createObservation(input), missionId: input.missionId, id: randomUUID(), recordedAt: stamp() };
      state.observations.push(observation); audit('outcome.recorded', { observationId: observation.id, missionId: observation.missionId, metric: observation.metric }); return observation;
    }),
    decideDecision: (id, { status, owner, evidence } = {}) => transaction(() => {
      const current = find(state.decisions, id, 'Decision');
      if (!['accepted', 'rejected'].includes(status)) throw new Error('Owner review must accept or reject a decision.');
      if (current.status !== 'proposed') throw new Error('This decision has already been reviewed.');
      Object.assign(current, createDecision({ ...current, status, owner, evidence }), { reviewedAt: stamp(), reviewedBy: 'owner' });
      audit('decision.reviewed', { decisionId: id, status }); return current;
    }),
    addMemory: (text, { source = 'owner', status = source === 'owner' ? 'confirmed' : 'proposed' } = {}) => transaction(() => {
      if (typeof text !== 'string' || text.trim().length < 3 || text.length > 2000) throw new Error('Memory needs 3–2000 characters.');
      if (!['owner', 'teammate'].includes(source) || !['confirmed', 'proposed'].includes(status) || (source !== 'owner' && status !== 'proposed')) throw new Error('Only the owner can confirm memory.');
      const memory = { id: randomUUID(), text: text.trim(), source, status, at: stamp() };
      state.memory.push(memory); audit(`memory.${status}`, { memoryId: memory.id }); return memory;
    }),
    confirmMemory: id => transaction(() => {
      const memory = find(state.memory, id, 'Memory');
      if (memory.status !== 'proposed') throw new Error('Memory is already confirmed.');
      memory.status = 'confirmed'; memory.confirmedBy = 'owner'; memory.confirmedAt = stamp();
      audit('memory.confirmed', { memoryId: id }); return memory;
    }),
    deleteMemory: id => transaction(() => {
      const memory = find(state.memory, id, 'Memory'); state.memory.splice(state.memory.indexOf(memory), 1);
      audit('memory.deleted', { memoryId: id }); return { deleted: true };
    }),
    requestAction: input => transaction(() => {
      const mission = input?.missionId ? missionById(input.missionId) : null;
      const action = { ...evaluateAction(input), missionRevision: mission?.revision ?? null, id: randomUUID(), createdAt: stamp(), executed: false };
      action.digest = actionDigest(action); state.approvals.unshift(action);
      audit('handoff.requested', { actionId: action.id, kind: action.kind, digest: action.digest }); return action;
    }),
    decideAction: (id, decision) => transaction(() => {
      const action = find(state.approvals, id, 'Approval');
      if (action.missionId && action.missionRevision !== missionById(action.missionId).revision) throw new Error('Mission changed since the handoff was proposed. Create a new request.');
      Object.assign(action, resolveApproval(action, decision)); audit('handoff.decided', { actionId: id, decision, executed: false }); return action;
    }),
    recordChat: ({ missionId = null, missionRevision, message, reply, model, usage }) => transaction(() => {
      const capturedRevision = missionId ? missionRevision ?? missionById(missionId).revision : null;
      if (missionId) checkRevision(missionById(missionId), capturedRevision);
      if (typeof message !== 'string' || !message.trim() || message.length > 12000 || typeof reply !== 'string' || !reply.trim() || reply.length > 2_000_000) throw new Error('Conversation needs a message of 1–12000 characters and a reply of 1–2000000 characters.');
      const exchange = { id: randomUUID(), missionId, missionRevision: capturedRevision, message, reply, model, usage, at: stamp() };
      state.conversations.push(exchange); audit('conversation.drafted', { exchangeId: exchange.id, missionId, model, usage }); return exchange;
    }),
    record: (type, details) => transaction(() => { audit(type, details); return { recorded: true }; }),
    nextActions: options => nextActions(snapshot(), options),
    readiness: id => { const current = snapshot(); return assessReadiness(find(current.missions, id, 'Mission'), current.tasks); },
    preview: id => buildDeliverables(getMission(id)),
  };
}
