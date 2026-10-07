import { buildDeliverables } from './events.mjs';
import { loadRole } from './role.mjs';
import { refineDrafts, callModel } from './model.mjs';

export function reviewDeliverables(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.some(item => !item || typeof item !== 'object')) return { passed: false, checks: [{ name: 'Artifacts exist', passed: false }], scope: 'Structural checks only.' };
  const checks = [
    { name: 'Artifacts exist', passed: Array.isArray(artifacts) && artifacts.length >= 8 },
    { name: 'Artifact names are unique', passed: new Set(artifacts.map(item => item.name)).size === artifacts.length },
    { name: 'Each document has substantive content', passed: artifacts.every(item => typeof item.content === 'string' && item.content.length >= 100) },
    { name: 'Budget and production exports present', passed: ['budget.csv', 'production-run-of-show.csv', 'risk-register.csv'].every(name => artifacts.some(item => item.name === name)) },
    { name: 'Measurements and follow-through present', passed: ['measurement-plan.md', 'follow-through.md'].every(name => artifacts.some(item => item.name === name)) },
  ];
  return { passed: checks.every(item => item.passed), checks, scope: 'Structural checks only. Event judgment, facts and real-world readiness require owner review.' };
}

export async function runMission(store, id, { live = false, env, fetchImpl } = {}) {
  const mission = store.getMission(id);
  const memory = store.snapshot().memory.filter(item => item.status === 'confirmed');
  let artifacts = buildDeliverables(mission);
  let generation = { mode: 'template', reflection: 'This is an offline starter pack. Verify assumptions, obtain quotes and assign named owners before delivery.' };
  if (live) {
    const result = await refineDrafts({ role: await loadRole(), mission, memory, artifacts, env, fetchImpl });
    artifacts = result.artifacts;
    generation = { mode: 'live', reflection: result.reflection, model: result.model, provider: result.provider, usage: result.usage };
  }
  if (memory.length) artifacts.push({ name: 'owner-preferences.md', title: 'Owner preferences', content: `# Owner preferences\n\nDraft context supplied by the owner; preferences cannot grant tool permissions. ${live ? 'Included in the live drafting request.' : 'Recorded alongside this template pack; offline templates do not reason over these preferences.'}\n\n${memory.map(item => `- ${item.text}`).join('\n')}\n` });
  const review = { ...reviewDeliverables(artifacts), generation };
  if (!review.passed) throw new Error(`Draft pack failed structural checks: ${review.checks.filter(item => !item.passed).map(item => item.name).join(', ')}`);
  return store.completeMission(id, artifacts, review, generation.mode, { expectedRevision: mission.revision, expectedDraftVersion: mission.draftVersion });
}

export async function askMira(store, message, { missionId, env, fetchImpl } = {}) {
  if (typeof message !== 'string' || !message.trim() || message.length > 12000) throw new Error('Ask a question of 1–12000 characters.');
  const state = store.snapshot();
  const mission = missionId ? store.getMission(missionId) : null;
  const history = state.conversations.filter(item => item.missionId === (missionId ?? null) && (item.missionRevision ?? null) === (mission?.revision ?? null)).slice(-6).flatMap(item => [{ role: 'user', content: item.message }, { role: 'assistant', content: item.reply }]);
  const result = await callModel({ role: await loadRole(), mission, memory: state.memory.filter(item => item.status === 'confirmed'), history, message, env, fetchImpl });
  await store.recordChat({ missionId: missionId ?? null, missionRevision: mission?.revision ?? null, message, reply: result.content, model: result.model, usage: result.usage });
  return { reply: result.content, mode: 'live', usage: result.usage };
}
