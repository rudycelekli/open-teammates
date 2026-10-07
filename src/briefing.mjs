import { nextActions, assessReadiness } from './work.mjs';

const clean = value => String(value ?? '').replace(/[\r\n]/g, ' ').replace(/[|<>]/g, ' ');
export function buildBriefing(store, { missionId, now = new Date() } = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('Briefing needs a valid clock.');
  const state = store.snapshot();
  if (missionId) store.getMission(missionId);
  const filtered = { ...state, missions: state.missions.filter(m => !missionId || m.id === missionId) };
  for (const key of ['tasks', 'decisions', 'observations', 'approvals']) filtered[key] = state[key].filter(item => !missionId || item.missionId === missionId);
  const actions = nextActions(filtered, { now });
  const lines = [
    '# Mira’s work briefing', '', `Computed: ${now.toISOString()}. This is an on-demand view of the local ledger.`, '',
    '## The next useful work', '',
    ...actions.slice(0, 12).map((action, index) => `${index + 1}. **${clean(action.priority)}: ${clean(action.title)}**. ${clean(action.reason)}${action.taskId ? ` Task: ${action.taskId}.` : ''}`),
    ...(actions.length ? [] : ['No actionable work is recorded. Create an event brief or inspect the current mission.']), '',
    '## Active event plans', '',
    ...filtered.missions.flatMap(mission => {
      const readiness = assessReadiness(mission, filtered.tasks);
      return [`### ${clean(mission.name)}`, '', `Mission: ${mission.id}. Brief revision ${mission.revision}; draft version ${mission.draftVersion}. ${mission.date} in ${mission.timezone}.`, '', `Budget ceiling: ${mission.currency} ${mission.budget.toLocaleString('en-US')}; capacity is a planning target of ${mission.capacity}.`, '', `Draft: ${mission.draftRevision === mission.revision ? 'current for this brief' : 'needs revision'}. Readiness: ${readiness.status}. This is an advisory checkpoint; it does not grant production go/no-go authority.`, ''];
    }),
    '## Reported outcomes', '',
    ...filtered.observations.map(item => `- ${clean(item.metric)}: ${item.value} ${clean(item.unit)}. Source: ${clean(item.source)}. Observed: ${item.observedAt}. ${clean(item.notes)}`),
    ...(filtered.observations.length ? [] : ['No actual outcome observations have been recorded. Targets and forecasts remain in the planning artifacts.']), '',
    '## Memory awaiting your review', '',
    ...state.memory.filter(item => item.status === 'proposed').map(item => `- ${clean(item.text)} (${item.id}). Proposed by the teammate; confirm or delete explicitly.`),
    ...(state.memory.some(item => item.status === 'proposed') ? [] : ['No proposed preferences are waiting for confirmation.']), '',
  ];
  return { markdown: lines.join('\n'), actions, missions: filtered.missions.map(m => ({ id: m.id, name: m.name, readiness: assessReadiness(m, filtered.tasks) })), computedAt: now.toISOString() };
}
