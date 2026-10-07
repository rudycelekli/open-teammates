/** Dependency-free work records and advisory planning. Nothing here executes an action. */
const STATUSES = new Set(['open', 'in_progress', 'blocked', 'done']);
const PRIORITIES = new Set(['critical', 'high', 'normal', 'low']);
const PRIORITY_ORDER = { critical: 0, high: 1, normal: 2, low: 3 };
const DAY = 86400000;
const PLACEHOLDER = /^(?:done|complete[d]?|finished|yes|ok(?:ay)?|approved|confirmed|n\/?a|none|tbd|todo|test|placeholder|looks good|task completed(?: successfully)?)[.!\s]*$/i;

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
}
function string(value, label, { optional = false, max = 6000 } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError(`${label} must be a non-empty string of at most ${max} characters.`);
  return value.trim();
}
function timestamp(value, label) {
  // An explicit offset keeps a server's timezone from silently changing deadlines.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new TypeError(`${label} must be an ISO timestamp with an explicit timezone offset.`);
  calendarDate(value.slice(0, 10));
  const clock = value.slice(11).match(/^(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (Number(clock[1]) > 23 || Number(clock[2]) > 59 || Number(clock[3] ?? 0) > 59 || !Number.isFinite(Date.parse(value))) throw new TypeError(`${label} must be a valid ISO timestamp.`);
  return new Date(value).toISOString();
}
function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError('date must be a real calendar date in YYYY-MM-DD format.');
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new TypeError('date must be a real calendar date in YYYY-MM-DD format.');
  return date;
}
function clockDate(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('now must be a valid Date.');
  return now;
}
function timezone(value) {
  const zone = string(value, 'timezone', { max: 100 });
  if (/^[+-]/.test(zone)) throw new TypeError('timezone must be a valid IANA timezone.');
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date(0)); }
  catch { throw new TypeError('timezone must be a valid IANA timezone.'); }
  return zone;
}
function localDate(instant, zone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key).value.padStart(key === 'year' ? 4 : 2, '0')).join('-');
}

/** Shift calendar days, rather than adding 24-hour durations across DST changes. */
export function shiftCalendarDate(date, days) {
  if (!Number.isSafeInteger(days)) throw new TypeError('days must be a safe integer.');
  const shifted = calendarDate(date);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  if (!Number.isFinite(shifted.getTime()) || shifted.getUTCFullYear() < 0 || shifted.getUTCFullYear() > 9999) throw new TypeError('Shifted date is outside the supported calendar range.');
  return shifted.toISOString().slice(0, 10);
}

/** Weekdays only. Local public holidays are deliberately not inferred. */
export function shiftWeekdays(date, days) {
  if (!Number.isSafeInteger(days) || Math.abs(days) > 10000) throw new TypeError('weekday offset must be an integer between -10000 and 10000.');
  let result = date;
  calendarDate(result);
  for (let remaining = Math.abs(days); remaining > 0;) {
    result = shiftCalendarDate(result, Math.sign(days));
    if (![0, 6].includes(calendarDate(result).getUTCDay())) remaining--;
  }
  return result;
}

/** Resolve 17:00 on an event-local date to UTC, including the date's actual DST offset. */
export function deadlineForDate(date, zone) {
  calendarDate(date);
  zone = timezone(zone);
  const desired = Date.parse(`${date}T17:00:00Z`);
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  let instant = desired;
  for (let attempt = 0; attempt < 6; attempt++) {
    const parts = formatter.formatToParts(new Date(instant));
    const part = key => parts.find(item => item.type === key).value.padStart(key === 'year' ? 4 : 2, '0');
    const represented = Date.parse(`${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}Z`);
    if (represented === desired) return new Date(instant).toISOString();
    instant += desired - represented;
  }
  throw new TypeError(`The calendar date ${date} does not have a 17:00 deadline in ${zone}.`);
}

function substantiveEvidence(value) {
  return typeof value === 'string' && value.trim().length >= 20 && !PLACEHOLDER.test(value.trim()) && new Set(value.toLowerCase().replace(/\s/g, '')).size >= 6;
}
function evidence(value, { required = false } = {}) {
  const normalized = string(value, 'evidence', { optional: !required });
  if (required && !substantiveEvidence(normalized)) throw new TypeError('Completion evidence must be substantive: describe what was verified and reference its source (at least 20 characters).');
  return normalized;
}
function ids(value = []) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) throw new TypeError('dependencies must be an array of task IDs.');
  const result = value.map(item => item.trim());
  if (new Set(result).size !== result.length) throw new TypeError('dependencies must not contain duplicate task IDs.');
  return result;
}

/** Normalize a task. Assigning an ID and recording who asserted evidence belong to the store. */
export function createTask(input, context = {}) {
  object(input, 'Task input');
  object(context, 'Task context');
  const status = input.status ?? 'open';
  const priority = input.priority ?? 'normal';
  if (!STATUSES.has(status)) throw new TypeError('status must be open, in_progress, blocked, or done.');
  if (!PRIORITIES.has(priority)) throw new TypeError('priority must be critical, high, normal, or low.');
  const task = {
    title: string(input.title, 'title', { max: 300 }),
    description: input.description === undefined ? '' : (string(input.description, 'description', { optional: true }) ?? ''),
    owner: string(input.owner, 'owner', { optional: true, max: 300 }),
    status, priority,
    dueAt: input.dueAt === undefined || input.dueAt === null ? null : timestamp(input.dueAt, 'dueAt'),
    dependencies: ids(input.dependencies),
    evidence: evidence(input.evidence, { required: status === 'done' }),
  };
  const missionId = input.missionId ?? context.missionId;
  if (missionId !== undefined && missionId !== null) task.missionId = string(missionId, 'missionId', { max: 100 });
  for (const field of ['acceptanceCriteria', 'suggestedOwner']) {
    if (input[field] !== undefined && input[field] !== null) task[field] = string(input[field], field, { max: 2000 });
  }
  if (input.date !== undefined) { calendarDate(input.date); task.date = input.date; }
  if (task.status === 'done' && !task.owner) throw new TypeError('A completed task needs an accountable owner.');
  if (context.tasks !== undefined) {
    validateDependencies(context.tasks, { ...task, id: context.id });
    if (task.status === 'done') assertCompletedDependencies(task, context.tasks);
  } else if (task.status === 'done' && task.dependencies.length) {
    throw new TypeError('Completing a task with dependencies requires the current task records.');
  }
  return task;
}

/** Validate references and cycles for the graph that would exist after saving candidate. */
export function validateDependencies(tasks, candidate) {
  if (!Array.isArray(tasks)) throw new TypeError('tasks must be an array.');
  object(candidate, 'Candidate task');
  const graph = new Map();
  for (const task of tasks) {
    object(task, 'Task');
    if (typeof task.id !== 'string' || !task.id) throw new TypeError('Existing tasks must have IDs.');
    if (graph.has(task.id)) throw new TypeError('Existing task IDs must be unique.');
    graph.set(task.id, task);
  }
  if (candidate.id) graph.set(candidate.id, candidate);
  for (const task of [...graph.values(), ...(candidate.id ? [] : [candidate])]) {
    for (const id of ids(task.dependencies)) {
      const dependency = graph.get(id);
      if (!dependency) throw new TypeError(`Dependency task ${id} does not exist.`);
      if (task.id === id) throw new TypeError('A task cannot depend on itself.');
      if (task.missionId && dependency.missionId && task.missionId !== dependency.missionId) throw new TypeError('Task dependencies must belong to the same mission.');
    }
  }
  const visited = new Set();
  const active = new Set();
  function visit(id) {
    if (active.has(id)) throw new TypeError('Task dependency cycle detected.');
    if (visited.has(id)) return;
    active.add(id);
    for (const dependency of graph.get(id).dependencies ?? []) visit(dependency);
    active.delete(id);
    visited.add(id);
  }
  for (const id of graph.keys()) visit(id);
  return true;
}

function completionIssues(task, tasks) {
  const byId = new Map(tasks.map(item => [item.id, item]));
  const problems = [];
  const checked = new Set();
  const active = new Set(task.id ? [task.id] : []);
  function visit(id) {
    if (active.has(id)) { problems.push('Dependency graph contains a cycle'); return; }
    if (checked.has(id)) return;
    checked.add(id);
    const dependency = byId.get(id);
    if (!dependency) { problems.push(`Dependency ${id} is missing`); return; }
    if (dependency.status !== 'done') problems.push(`Dependency ${dependency.title || id} is ${dependency.status || 'unresolved'}`);
    else if (!substantiveEvidence(dependency.evidence) || !dependency.owner) problems.push(`Dependency ${dependency.title || id} lacks accountable completion evidence`);
    active.add(id);
    for (const upstream of dependency.dependencies ?? []) visit(upstream);
    active.delete(id);
  }
  for (const id of task.dependencies ?? []) visit(id);
  return [...new Set(problems)];
}
function assertCompletedDependencies(task, tasks) {
  const unresolved = completionIssues(task, tasks);
  if (unresolved.length) throw new TypeError(`Cannot complete task with unmet dependencies: ${unresolved.join('; ')}.`);
}

/** Never infer completion from a finished draft, a deadline, or a completed upstream task. */
export function validateTaskUpdate(current, patch, { tasks = [], now = new Date() } = {}) {
  object(current, 'Current task');
  object(patch, 'Task patch');
  clockDate(now);
  if (Object.hasOwn(patch, 'id') || (Object.hasOwn(patch, 'missionId') && patch.missionId !== current.missionId)) throw new TypeError('Task identity and mission cannot be changed.');
  const task = createTask({ ...current, ...patch }, { tasks, id: current.id });
  return task;
}

/** Suggested work only. Owners remain unassigned and every completion requires supplied proof. */
export function seedMissionTasks(mission) {
  object(mission, 'Mission');
  calendarDate(mission.date);
  timezone(mission.timezone);
  const virtual = mission.format === 'webinar';
  const internal = mission.format === 'internal';
  const definitions = [
    ['strategy', -60, 'Agree the attendee promise, portfolio priority, and accountable owners', 'Events lead + executive sponsor', 'high', [], 'Record an owner-reviewed brief, the primary audience, investment rationale, success definitions, and named decision rights.'],
    ['finance', -45, 'Reconcile the event ceiling, quotes, and contingency with Finance', 'Budget owner + Finance', 'high', ['strategy'], 'Reference a Finance-reviewed estimate with quoted versus assumed costs, tax, travel, reserve, and the full budget reconciliation. No draft allocation counts as approved spend.'],
    ['procurement', -35, virtual ? 'Review platform, studio, and supplier scope with Procurement, Legal, and Security' : 'Review venue, supplier, and agency scope with Procurement, Legal, and Security', 'Operations lead + Procurement', 'high', ['finance'], 'Reference reviewed scope, comparison evidence, accessibility fit, security requirements, contract review, and the owner authorization route. No booking or contract is implied.'],
    ['content', -28, internal ? 'Develop leadership programming, employee questions, and accurate demonstrations' : 'Develop audience-specific programming, speakers, and accurate demonstrations', 'Program lead + Product / Research', 'normal', ['strategy'], 'Reference tested product material, a coherent audience journey, contributor preparation, rights checks, and an offline demonstration fallback.'],
    ['accessibility', -21, virtual ? 'Verify remote access, captions, interpretation, and participant support' : 'Verify accessible routes, captions, dietary choices, quiet space, and participant support', 'Attendee experience + accessibility lead', 'high', ['strategy'], 'Reference an access review, participant support route, tested captions, accommodations process, and owned resolutions for identified gaps.'],
    ['audience', -21, 'Review registration, audience goals, consent, and measurement baselines', 'Audience lead + data / measurement owner', 'normal', ['strategy'], 'Reference reviewed invitations and registration wording, opt-in choices, audience segments, access controls, baseline sources, and denominator definitions.'],
    ['production', -7, virtual ? 'Rehearse the broadcast, caption feed, moderation, and technical fallback' : 'Rehearse the production cues, build labs, access routes, and technical fallback', 'Executive producer + Security / operations', 'high', ['procurement', 'content', 'accessibility'], 'Reference a timed rehearsal record, cue ownership, tested backups, incident escalation, and named owners for unresolved production issues. A run-of-show draft is not rehearsal evidence.'],
    ['follow-through-kit', -7, 'Prepare useful follow-through assets and permitted next-step choices', 'Developer / regional / revenue programs + editorial', 'normal', ['content', 'audience'], 'Reference checked resources, caption and rights checks, appropriate access, opt-in routes, and owners for participant questions. External sends and publishing remain separate handoffs.'],
    ['owner-review', -2, 'Prepare an evidence-led owner readiness review and unresolved decisions', 'Executive sponsor + events lead', 'high', ['finance', 'procurement', 'accessibility', 'audience', 'production', 'follow-through-kit'], 'Reference the owner review record, explicit remaining risks, escalation owners, and any scope changes. This checkpoint does not grant venue, spend, publication, or event-day authority.'],
    ['resources', 1, 'Record the reviewed resource follow-through and participant support route', 'Audience + developer programs lead', 'normal', ['follow-through-kit', 'owner-review'], 'Reference actual permitted delivery receipts or record why delivery remains blocked; include useful resources, support choices, and the real audience reached. A drafted message is not a send receipt.', true],
    ['answers', 2, 'Resolve participant questions, access issues, and incident follow-up', 'Attendee experience + program lead', 'normal', ['resources'], 'Reference the answer and incident log, accountable responses, and explicit unresolved issues. Do not silently close an unanswered participant question.', true],
    ['outcomes', 30, 'Review actual outcomes, reconcile costs, and decide what to repeat or change', 'Measurement owner + Finance + events lead', 'normal', ['answers'], 'Reference actual metric sources and denominators, cost reconciliation, sampling and attribution limits, and owned repeat/change/stop decisions. Targets and capacity are not observed results.'],
  ];
  return definitions.map(([key, offset, title, suggestedOwner, priority, dependsOnKeys, acceptanceCriteria, weekdays]) => {
    const date = weekdays ? shiftWeekdays(mission.date, offset) : shiftCalendarDate(mission.date, offset);
    return {
      ...createTask({ title, owner: null, priority, date, dueAt: deadlineForDate(date, mission.timezone), suggestedOwner, acceptanceCriteria, description: `Proposed accountable role: ${suggestedOwner}; assign an owner before completion. ${acceptanceCriteria}${weekdays ? ' Deadline uses weekdays only; verify local public holidays.' : ''}` }, { missionId: mission.id }),
      key, dependsOnKeys,
    };
  });
}

/** Decisions record judgment; accepting one requires a named owner and supplied evidence. */
export function createDecision(input) {
  object(input, 'Decision input');
  const status = input.status ?? 'proposed';
  if (!['proposed', 'accepted', 'rejected'].includes(status)) throw new TypeError('Decision status must be proposed, accepted, or rejected.');
  const result = {
    question: string(input.question, 'question', { max: 1000 }),
    recommendation: string(input.recommendation, 'recommendation', { max: 6000 }),
    rationale: string(input.rationale, 'rationale', { max: 6000 }),
    owner: string(input.owner, 'owner', { optional: true, max: 300 }),
    status,
    evidence: evidence(input.evidence, { required: status === 'accepted' }),
    revisitWhen: string(input.revisitWhen, 'revisitWhen', { optional: true, max: 1000 }),
  };
  if (status === 'accepted' && !result.owner) throw new TypeError('An accepted decision needs an accountable owner.');
  if (input.missionId !== undefined && input.missionId !== null) result.missionId = string(input.missionId, 'missionId', { max: 100 });
  return result;
}

/** Record only caller-supplied actual observations. A target belongs in the plan. */
export function createObservation(input) {
  object(input, 'Observation input');
  if ([input.kind, input.type, input.status].some(value => value !== undefined && /^(?:target|planned|forecast|projection|hypothesis)$/i.test(value)) || input.isTarget === true || Object.hasOwn(input, 'target') || Object.hasOwn(input, 'targetValue')) throw new TypeError('An observation must record an actual result; targets and forecasts belong in the measurement plan.');
  if (typeof input.value !== 'number' || !Number.isFinite(input.value)) throw new TypeError('Observed value must be a finite number.');
  const source = string(input.source, 'source', { max: 2000 });
  if (source.length < 3 || PLACEHOLDER.test(source)) throw new TypeError('An observation needs an explicit source for the actual result.');
  const result = {
    kind: 'observed',
    metric: string(input.metric, 'metric', { max: 300 }),
    value: input.value,
    unit: string(input.unit, 'unit', { max: 100 }),
    source,
    observedAt: timestamp(input.observedAt, 'observedAt'),
    notes: input.notes === undefined ? '' : (string(input.notes, 'notes', { optional: true }) ?? ''),
  };
  if (input.missionId !== undefined && input.missionId !== null) result.missionId = string(input.missionId, 'missionId', { max: 100 });
  return result;
}

function priorityFor(task, now) {
  let priority = task.priority ?? 'normal';
  if (task.dueAt && Number.isFinite(Date.parse(task.dueAt))) {
    const remaining = Date.parse(task.dueAt) - now.getTime();
    if (remaining < 0) priority = 'critical';
    else if (remaining <= 3 * DAY && PRIORITY_ORDER[priority] > 1) priority = 'high';
  }
  return priority;
}

/** A deterministic suggestion queue computed on request. No background monitoring is implied. */
export function nextActions({ missions = [], tasks = [], decisions = [], approvals = [], observations = [] } = {}, { now = new Date() } = {}) {
  clockDate(now);
  for (const list of [missions, tasks, decisions, approvals, observations]) if (!Array.isArray(list)) throw new TypeError('Work collections must be arrays.');
  const actions = [];
  const add = (item, record) => actions.push({ ...item, ...(record.missionId ? { missionId: record.missionId } : {}), ...(record.id ? { id: record.id } : {}) });
  for (const task of tasks) {
    const dependencies = completionIssues(task, tasks);
    const priority = priorityFor(task, now);
    const due = task.dueAt && Date.parse(task.dueAt) < now.getTime() ? ` Deadline passed at ${task.dueAt}; confirm scope and a recovery date.` : '';
    const base = { priority, title: task.title, taskId: task.id, needsOwner: !task.owner };
    if (task.status === 'done') {
      if (!substantiveEvidence(task.evidence) || !task.owner || dependencies.length) add({ ...base, kind: 'evidence_gap', priority: 'high', reason: `Completed status needs review: ${dependencies.length ? dependencies.join('; ') : 'accountable owner and substantive completion evidence are required'}.` }, task);
      continue;
    }
    if (task.status === 'blocked') {
      add({ ...base, kind: 'blocker', priority: priority === 'critical' ? priority : 'high', reason: `Resolve the recorded blockage with ${task.owner ?? 'an accountable owner'} before resuming.${dependencies.length ? ` ${dependencies.join('; ')}.` : ''}${due}` }, task);
    } else if (!task.owner) {
      add({ ...base, kind: 'owner', reason: `Assign an accountable owner${task.suggestedOwner ? `; suggested role: ${task.suggestedOwner}` : ''}.${due}` }, task);
    } else if (dependencies.some(reason => reason.endsWith('is missing') || reason.includes('lacks accountable') || reason.includes('cycle'))) {
      add({ ...base, kind: 'blocker', priority: priority === 'critical' ? priority : 'high', reason: `Repair prerequisite records before starting: ${dependencies.join('; ')}.${due}` }, task);
    } else if (!dependencies.length) {
      add({ ...base, kind: 'task', reason: `${task.status === 'in_progress' ? 'Continue the current work' : 'Start this work; prerequisites have recorded completion evidence'}. ${task.acceptanceCriteria ?? 'Record concrete verification before marking done.'}${due}` }, task);
    }
  }
  for (const decision of decisions) {
    if (decision.status === 'proposed') add({ kind: 'decision', priority: decision.owner ? 'normal' : 'high', title: decision.question, reason: `${decision.owner ? `Ask ${decision.owner} to review` : 'Assign a decision owner and review'} the recommendation and its evidence; proposed judgment is not authorization.`, needsOwner: !decision.owner }, decision);
    else if (decision.status === 'accepted' && (!decision.owner || !substantiveEvidence(decision.evidence))) add({ kind: 'evidence_gap', priority: 'high', title: decision.question, reason: 'An accepted decision needs an accountable owner and substantive supporting evidence.', needsOwner: !decision.owner }, decision);
  }
  for (const approval of approvals) {
    if (approval.status === 'pending') add({ kind: 'approval', priority: 'high', title: approval.summary, reason: 'Review the exact handoff payload. A decision records permission; this package does not execute the external action.', needsOwner: true }, approval);
  }
  for (const mission of missions) {
    const related = tasks.filter(task => task.missionId === mission.id);
    if (Number.isSafeInteger(mission.revision) && mission.draftRevision !== mission.revision) {
      const existing = mission.draftRevision !== undefined && mission.draftRevision !== null;
      add({ kind: 'draft', priority: existing ? 'high' : 'normal', title: `${existing ? 'Refresh' : 'Prepare'} the draft pack for ${mission.name}`, reason: existing ? `The brief is revision ${mission.revision}; the saved pack was drafted from revision ${mission.draftRevision}. Regenerate and review the affected budget, program, production, and follow-through proposals.` : 'No draft pack records the current brief revision. Prepare proposals and review assumptions before treating the artifacts as current.', needsOwner: false }, { ...mission, missionId: mission.id });
    }
    if (!related.length) add({ kind: 'plan', priority: 'normal', title: `Establish the work plan for ${mission.name}`, reason: 'Assign work, owners, event-relative dates, prerequisites, and completion evidence before treating the draft as an operating plan.', needsOwner: true }, { ...mission, missionId: mission.id });
    const measurementDue = mission.date && mission.timezone ? deadlineForDate(shiftCalendarDate(mission.date, 30), mission.timezone) : null;
    const outcomeTasks = related.filter(task => task.key === 'outcomes' || /review actual outcomes/i.test(task.title ?? ''));
    if (measurementDue && now.getTime() >= Date.parse(measurementDue) && !observations.some(item => item.missionId === mission.id && item.kind !== 'target') && !outcomeTasks.some(item => item.status !== 'done')) {
      add({ kind: 'measurement', priority: 'normal', title: `Collect actual outcomes for ${mission.name}`, reason: 'The event is more than 30 days past. No actual sourced observations are recorded; capacity, proposed targets, and drafted follow-up cannot establish outcomes.', needsOwner: true }, { ...mission, missionId: mission.id });
    }
  }
  const deadlines = new Map(tasks.map(task => [task.id, task.dueAt ? Date.parse(task.dueAt) : Infinity]));
  return actions.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || Number(b.kind === 'blocker') - Number(a.kind === 'blocker') || (deadlines.get(a.taskId) ?? Infinity) - (deadlines.get(b.taskId) ?? Infinity) || a.title.localeCompare(b.title) || (a.id ?? '').localeCompare(b.id ?? ''));
}

/** Advisory pre-event task readiness. Post-event work stays open without blocking this checkpoint. */
export function assessReadiness(mission, tasks) {
  object(mission, 'Mission');
  if (!Array.isArray(tasks)) throw new TypeError('tasks must be an array.');
  const related = tasks.filter(task => !mission.id || task.missionId === mission.id);
  const zone = mission.timezone ? timezone(mission.timezone) : 'UTC';
  if (mission.date) calendarDate(mission.date);
  const preEvent = related.filter(task => {
    const date = task.dueAt ? localDate(new Date(timestamp(task.dueAt, 'dueAt')), zone) : task.date;
    return !mission.date || !date || date <= mission.date;
  });
  const followThrough = related.filter(task => !preEvent.includes(task));
  const blockers = [];
  let complete = 0;
  if (!preEvent.length) blockers.push({ kind: 'missing_plan', title: 'No pre-event work plan is recorded.' });
  for (const task of preEvent) {
    const unmet = completionIssues(task, related);
    const problems = [];
    if (!task.owner) problems.push('No accountable owner');
    if (task.status !== 'done') problems.push(task.status === 'blocked' ? 'Recorded blockage is unresolved' : `Task remains ${task.status ?? 'open'}`);
    if (task.status === 'done' && !substantiveEvidence(task.evidence)) problems.push('Completion evidence is missing or not substantive');
    problems.push(...unmet);
    if (problems.length) blockers.push({ kind: task.status === 'blocked' ? 'blocker' : 'task', taskId: task.id, title: task.title, reasons: problems });
    else complete++;
  }
  try { validateDependencies(related, { dependencies: [] }); }
  catch (error) { blockers.push({ kind: 'dependency_graph', title: error.message }); }
  const total = preEvent.length;
  return {
    status: total > 0 && blockers.length === 0 ? 'ready_for_owner_review' : 'needs_work',
    score: total ? Math.round(complete / total * 100) : 0,
    complete, total,
    followThrough: { complete: followThrough.filter(task => task.status === 'done' && task.owner && substantiveEvidence(task.evidence) && !completionIssues(task, related).length).length, total: followThrough.length },
    blockers,
    authority: 'advisory_only',
    scope: 'Recorded pre-event task evidence only. The accountable owner must verify facts, risks, approvals, and real event go/no-go. Post-event work is tracked separately.',
  };
}
