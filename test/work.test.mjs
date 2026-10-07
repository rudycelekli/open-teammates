import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_BRIEF, createMission } from '../src/events.mjs';
import { createTask, validateTaskUpdate, validateDependencies, seedMissionTasks, createDecision, createObservation, nextActions, assessReadiness, shiftCalendarDate, shiftWeekdays, deadlineForDate } from '../src/work.mjs';

const NOW = new Date('2026-10-07T14:00:00.000Z');
const PROOF = 'Rehearsal completed with backup playback; cue log /records/rehearsal-2027-03-11.md reviewed by Jo.';
const mission = (overrides = {}) => ({ ...createMission({ ...DEMO_BRIEF, ...overrides }, NOW), id: 'event-1' });
const task = (id, input = {}) => ({ ...createTask({ title: `Task ${id}`, missionId: 'event-1', ...input }), id });

test('tasks normalize owned work without assigning IDs, inventing deadlines, or recording completion', () => {
  const input = { title: '  Inspect access routes  ', dependencies: [] };
  const normalized = createTask(input);
  assert.deepEqual(normalized, { title: 'Inspect access routes', description: '', owner: null, status: 'open', priority: 'normal', dueAt: null, dependencies: [], evidence: null });
  assert.equal(Object.hasOwn(normalized, 'id'), false);
  normalized.dependencies.push('later');
  assert.deepEqual(input.dependencies, []);
  assert.throws(() => createTask({ title: 'Inspect', status: 'finished' }), /status/);
  assert.throws(() => createTask({ title: 'Inspect', priority: 'urgent' }), /priority/);
  assert.throws(() => createTask({ title: 'Inspect', dependencies: ['a', 'a'] }), /duplicate/);
  assert.throws(() => createTask({ title: 'Inspect', owner: 12 }), /owner/);
  assert.throws(() => createTask({ title: 'Inspect', dueAt: '2027-03-11T17:00:00' }), /explicit timezone/);
  assert.throws(() => createTask({ title: 'Inspect', dueAt: '2027-02-29T17:00:00Z' }), /real calendar/);
  assert.throws(() => createTask({ title: 'Inspect', dueAt: '2027-03-11T24:00:00Z' }), /valid ISO/);
  assert.equal(createTask({ title: 'Inspect', dueAt: '2027-03-11T17:00:00-07:00' }).dueAt, '2027-03-12T00:00:00.000Z');
});

test('completed work requires substantive caller-supplied evidence and an accountable owner', () => {
  const current = task('rehearsal', { owner: 'Jo' });
  for (const evidence of [undefined, null, '', 'done', 'Task completed successfully.', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
    assert.throws(() => validateTaskUpdate(current, { status: 'done', evidence }, { tasks: [current], now: NOW }), /evidence/);
  }
  assert.throws(() => createTask({ title: 'Inspect', status: 'done', evidence: PROOF }), /owner/);
  const finished = validateTaskUpdate(current, { status: 'done', evidence: PROOF }, { tasks: [current], now: NOW });
  assert.equal(finished.status, 'done');
  assert.equal(finished.evidence, PROOF);
  assert.equal(Object.hasOwn(finished, 'id'), false);
  assert.equal(current.status, 'open');
  assert.throws(() => validateTaskUpdate(current, { id: 'new' }, { tasks: [current], now: NOW }), /identity/);
  assert.throws(() => validateTaskUpdate(current, { missionId: 'other' }, { tasks: [current], now: NOW }), /identity/);
});

test('completion checks the real prerequisite state and never propagates done downstream', () => {
  const upstream = task('upstream', { owner: 'Jo' });
  const downstream = task('downstream', { owner: 'Sam', dependencies: ['upstream'] });
  assert.throws(() => validateTaskUpdate(downstream, { status: 'done', evidence: PROOF }, { tasks: [upstream, downstream], now: NOW }), /unmet dependencies/);
  const invalidDone = { ...upstream, status: 'done', evidence: 'done' };
  assert.throws(() => validateTaskUpdate(downstream, { status: 'done', evidence: PROOF }, { tasks: [invalidDone, downstream], now: NOW }), /completion evidence/);
  const done = { ...upstream, ...validateTaskUpdate(upstream, { status: 'done', evidence: PROOF }, { tasks: [upstream, downstream], now: NOW }) };
  assert.equal(validateTaskUpdate(downstream, { status: 'done', evidence: PROOF }, { tasks: [done, downstream], now: NOW }).status, 'done');
  assert.equal(downstream.status, 'open');
  assert.equal(upstream.status, 'open');
  assert.throws(() => createTask({ title: 'Dependent', owner: 'Sam', status: 'done', evidence: PROOF, dependencies: ['upstream'] }), /current task records/);
});

test('dependency graph rejects missing references, self-links, cycles, and cross-mission links', () => {
  const a = task('a');
  const b = task('b', { dependencies: ['a'] });
  const c = task('c', { dependencies: ['b'] });
  assert.equal(validateDependencies([a, b, c], { ...a }), true);
  assert.throws(() => validateDependencies([a, b, c], { ...a, dependencies: ['c'] }), /cycle/);
  assert.throws(() => validateDependencies([a], { ...a, dependencies: ['a'] }), /itself/);
  assert.throws(() => validateDependencies([a], { ...a, dependencies: ['missing'] }), /does not exist/);
  assert.throws(() => validateDependencies([a, { ...b, missionId: 'other' }], { ...a }), /same mission/);
  assert.throws(() => validateDependencies([a, a], { ...a }), /unique/);
  assert.throws(() => validateTaskUpdate(a, { dependencies: ['c'] }, { tasks: [a, b, c], now: NOW }), /cycle/);
});

test('an upstream completed label cannot hide an unresolved prerequisite or later reopening', () => {
  const a = task('a', { owner: 'Jo' });
  const b = { ...task('b', { owner: 'Sam', dependencies: ['a'] }), status: 'done', evidence: PROOF };
  const c = task('c', { owner: 'Lee', dependencies: ['b'] });
  assert.throws(() => validateTaskUpdate(c, { status: 'done', evidence: PROOF }, { tasks: [a, b, c], now: NOW }), /unmet dependencies/);
  const actions = nextActions({ tasks: [a, b, c] }, { now: NOW });
  assert.equal(actions.find(item => item.taskId === 'b').kind, 'evidence_gap');
  assert.equal(actions.some(item => item.taskId === 'c'), false);
  const circular = [{ ...a, dependencies: ['c'] }, b, c];
  assert.ok(nextActions({ tasks: circular }, { now: NOW }).some(item => item.kind === 'blocker' && /cycle/.test(item.reason)));
});

test('calendar shifts survive leap years, year boundaries, weekends, and invalid dates', () => {
  assert.equal(shiftCalendarDate('2028-03-01', -1), '2028-02-29');
  assert.equal(shiftCalendarDate('2027-01-01', -1), '2026-12-31');
  assert.equal(shiftCalendarDate('2027-12-31', 30), '2028-01-30');
  assert.equal(shiftWeekdays('2027-03-19', 1), '2027-03-22');
  assert.equal(shiftWeekdays('2027-03-19', 2), '2027-03-23');
  assert.equal(shiftWeekdays('2027-03-22', -1), '2027-03-19');
  assert.equal(shiftWeekdays('2027-03-20', 0), '2027-03-20');
  assert.throws(() => shiftCalendarDate('2027-02-29', 1), /real calendar/);
  assert.throws(() => shiftCalendarDate('2027-03-19', 1.5), /integer/);
  assert.throws(() => shiftWeekdays('2027-03-19', Infinity), /integer/);
});

test('event-local deadlines account for DST and non-hour UTC offsets', () => {
  assert.equal(deadlineForDate('2027-03-11', 'America/Los_Angeles'), '2027-03-12T01:00:00.000Z');
  assert.equal(deadlineForDate('2027-03-18', 'America/Los_Angeles'), '2027-03-19T00:00:00.000Z');
  assert.equal(deadlineForDate('2027-03-18', 'Asia/Kolkata'), '2027-03-18T11:30:00.000Z');
  assert.equal(deadlineForDate('2027-03-18', 'Pacific/Kiritimati'), '2027-03-18T03:00:00.000Z');
  assert.throws(() => deadlineForDate('2027-03-18', 'Not/A_Zone'), /IANA/);
  assert.throws(() => deadlineForDate('2011-12-30', 'Pacific/Apia'), /does not have/);
});

test('seeding produces dated work with honest assignments, operational gates, and follow-through proof', () => {
  const m = mission({ date: '2027-03-19' });
  const seeds = seedMissionTasks(m);
  assert.equal(seeds.length, 12);
  assert.equal(new Set(seeds.map(item => item.key)).size, seeds.length);
  assert.ok(seeds.every(item => item.status === 'open' && item.evidence === null && item.owner === null && item.suggestedOwner && item.acceptanceCriteria));
  assert.ok(seeds.every(item => !Object.hasOwn(item, 'id') && item.missionId === m.id));
  assert.equal(seeds.find(item => item.key === 'strategy').date, '2027-01-18');
  assert.equal(seeds.find(item => item.key === 'production').date, '2027-03-12');
  assert.equal(seeds.find(item => item.key === 'production').dueAt, '2027-03-13T01:00:00.000Z');
  assert.equal(seeds.find(item => item.key === 'resources').date, '2027-03-22');
  assert.equal(seeds.find(item => item.key === 'answers').date, '2027-03-23');
  assert.equal(seeds.find(item => item.key === 'outcomes').date, '2027-04-18');
  assert.ok(seeds.some(item => /Finance/.test(item.title)));
  assert.ok(seeds.some(item => /Procurement/.test(item.title)));
  assert.ok(seeds.some(item => /caption/i.test(item.title)));
  assert.ok(seeds.some(item => /rehearse/i.test(item.title)));
  assert.match(seeds.find(item => item.key === 'outcomes').acceptanceCriteria, /Targets and capacity are not observed results/);
  const map = new Map(seeds.map(item => [item.key, `uuid-${item.key}`]));
  const assigned = seeds.map(seed => ({ ...seed, id: map.get(seed.key), dependencies: seed.dependsOnKeys.map(key => map.get(key)) }));
  assert.equal(validateDependencies(assigned, { dependencies: [] }), true);
  assert.match(seedMissionTasks(mission({ format: 'webinar' })).find(item => item.key === 'production').title, /broadcast/);
  assert.match(seedMissionTasks(mission({ format: 'internal' })).find(item => item.key === 'content').title, /employee questions/);
});

test('decision proposals never become accepted without actual review evidence and an owner', () => {
  const input = { question: 'What should we protect?', recommendation: 'Protect the hands-on learning promise.', rationale: 'The objective requires useful product understanding.' };
  const decision = createDecision(input);
  assert.equal(decision.status, 'proposed');
  assert.equal(decision.owner, null);
  assert.equal(decision.evidence, null);
  assert.throws(() => createDecision({ ...input, status: 'accepted', owner: 'Jo' }), /evidence/);
  assert.throws(() => createDecision({ ...input, status: 'accepted', evidence: PROOF }), /owner/);
  assert.equal(createDecision({ ...input, status: 'accepted', owner: 'Jo', evidence: PROOF }).status, 'accepted');
  assert.equal(createDecision({ ...input, status: 'rejected', rationale: 'Sponsor chose a regional continuation instead.' }).status, 'rejected');
});

test('actual observations keep explicit source, units, time, and limitations; targets cannot be promoted', () => {
  const input = { metric: 'Participants completing a useful prototype', value: 173, unit: 'participants', source: 'Reviewed lab completion export /reports/labs-2027-03-19.csv', observedAt: '2027-03-19T16:00:00-07:00', notes: '173 of 211 opt-in respondents; response bias remains.', missionId: 'event-1' };
  const observation = createObservation(input);
  assert.equal(observation.value, 173);
  assert.equal(observation.kind, 'observed');
  assert.equal(observation.observedAt, '2027-03-19T23:00:00.000Z');
  assert.equal(observation.notes, input.notes);
  for (const patch of [{ kind: 'target' }, { type: 'forecast' }, { status: 'planned' }, { isTarget: true }, { targetValue: 200 }, { target: 200 }]) assert.throws(() => createObservation({ ...input, ...patch }), /actual result/);
  for (const value of [NaN, Infinity, '173', null]) assert.throws(() => createObservation({ ...input, value }), /finite number/);
  for (const source of [undefined, '', 'tbd', 'n/a']) assert.throws(() => createObservation({ ...input, source }), /source/);
  assert.throws(() => createObservation({ ...input, observedAt: undefined }), /observedAt/);
  assert.throws(() => createObservation({ ...input, unit: '' }), /unit/);
  assert.equal(createObservation({ ...input, value: 0 }).value, 0);
});

test('the next action queue prioritizes real deadline pressure and recorded blockages without inventing urgency', () => {
  const tasks = [
    task('future', { owner: 'Jo', priority: 'low', dueAt: '2027-03-01T17:00:00Z' }),
    task('overdue', { owner: 'Sam', dueAt: '2026-10-06T17:00:00Z' }),
    task('blocked', { owner: 'Sam', status: 'blocked', description: 'Awaiting a quote with confirmed accessibility.' }),
    task('unassigned'),
    task('waiting', { owner: 'Jo', dependencies: ['blocked'] }),
  ];
  const original = structuredClone(tasks);
  const actions = nextActions({ missions: [mission()], tasks }, { now: NOW });
  assert.equal(actions[0].taskId, 'overdue');
  assert.equal(actions[0].priority, 'critical');
  assert.equal(actions.find(item => item.taskId === 'future').priority, 'low');
  assert.equal(actions.find(item => item.taskId === 'blocked').kind, 'blocker');
  assert.equal(actions.find(item => item.taskId === 'unassigned').kind, 'owner');
  assert.equal(actions.some(item => item.taskId === 'waiting'), false);
  assert.deepEqual(tasks, original);
});

test('next actions distinguish requests for review from external execution and stale draft revisions', () => {
  const actions = nextActions({ missions: [{ ...mission(), revision: 3, draftRevision: 2 }], tasks: [task('a', { owner: 'Jo' })], decisions: [{ id: 'd1', question: 'Reduce the plenary?', status: 'proposed', owner: null, missionId: 'event-1' }], approvals: [{ id: 'h1', summary: 'Review the venue offer', status: 'pending', missionId: 'event-1' }, { id: 'h2', summary: 'Approved handoff', status: 'approved_for_handoff', executed: false }] }, { now: NOW });
  assert.ok(actions.some(item => item.kind === 'draft' && /revision 3/.test(item.reason) && /revision 2/.test(item.reason)));
  assert.ok(actions.some(item => item.kind === 'decision' && item.needsOwner));
  assert.ok(actions.some(item => item.kind === 'approval' && /does not execute/.test(item.reason)));
  assert.equal(actions.some(item => item.id === 'h2'), false);
  const corrupt = { ...task('bad', { owner: 'Jo' }), status: 'done', evidence: null };
  assert.equal(nextActions({ tasks: [corrupt] }, { now: NOW })[0].kind, 'evidence_gap');
});

test('capacity and planned budget never appear as achieved outcomes or imply completed follow-through', () => {
  const m = mission();
  const later = new Date('2027-04-20T16:00:00Z');
  const actions = nextActions({ missions: [m], tasks: [], observations: [] }, { now: later });
  assert.ok(actions.some(item => item.kind === 'measurement' && /capacity, proposed targets/.test(item.reason)));
  assert.equal(Object.hasOwn(actions.find(item => item.kind === 'measurement'), 'value'), false);
  const observed = createObservation({ metric: 'Actual turnout', value: 347, unit: 'people', source: 'Reviewed check-in tally /reports/turnout.csv', observedAt: '2027-03-19T00:00:00Z', missionId: m.id });
  assert.equal(nextActions({ missions: [m], observations: [observed] }, { now: later }).some(item => item.kind === 'measurement'), false);
  assert.equal(nextActions({ missions: [m], observations: [{ ...observed, kind: 'target' }] }, { now: later }).some(item => item.kind === 'measurement'), true);
});

test('readiness is an advisory pre-event checkpoint, requiring evidence and exposing blocked work', () => {
  const m = mission();
  const pre = task('pre', { owner: 'Jo', dueAt: '2027-03-18T17:00:00-07:00' });
  const post = task('post', { owner: 'Sam', dueAt: '2027-03-19T17:00:00-07:00', dependencies: ['pre'] });
  const blocked = { ...pre, status: 'blocked' };
  const assessment = assessReadiness(m, [blocked, post]);
  assert.equal(assessment.status, 'needs_work');
  assert.equal(assessment.authority, 'advisory_only');
  assert.equal(assessment.total, 1);
  assert.equal(assessment.complete, 0);
  assert.equal(assessment.followThrough.total, 1);
  assert.ok(assessment.blockers.some(item => item.reasons?.includes('Recorded blockage is unresolved')));
  const completed = { ...pre, ...validateTaskUpdate(pre, { status: 'done', evidence: PROOF }, { tasks: [pre, post], now: NOW }) };
  const ready = assessReadiness(m, [completed, post]);
  assert.equal(ready.status, 'ready_for_owner_review');
  assert.equal(ready.score, 100);
  assert.equal(ready.followThrough.complete, 0);
  assert.match(ready.scope, /real event go\/no-go/);
  assert.equal(post.status, 'open');
});

test('readiness detects false completion, dependency gaps, cycles, and missing plans', () => {
  const m = mission();
  assert.equal(assessReadiness(m, []).status, 'needs_work');
  const a = { ...task('a', { owner: 'Jo' }), status: 'done', evidence: PROOF, dependencies: ['b'] };
  const b = { ...task('b', { owner: 'Sam' }), status: 'done', evidence: PROOF, dependencies: ['a'] };
  const cycle = assessReadiness(m, [a, b]);
  assert.equal(cycle.status, 'needs_work');
  assert.ok(cycle.blockers.some(item => item.kind === 'dependency_graph' && /cycle/.test(item.title)));
  assert.equal(assessReadiness(m, [{ ...a, dependencies: [], evidence: 'done' }]).status, 'needs_work');
  assert.equal(assessReadiness(m, [{ ...a, dependencies: ['missing'] }]).status, 'needs_work');
  assert.equal(assessReadiness(m, [{ ...a, dependencies: [], owner: null }]).status, 'needs_work');
});
