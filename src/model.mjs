import { systemPrompt } from './role.mjs';

export function modelConfig(env = process.env) {
  const baseUrl = env.OPEN_TEAMMATES_BASE_URL || 'https://api.openai.com/v1';
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('OPEN_TEAMMATES_BASE_URL must be a valid URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) throw new Error('Use an HTTPS provider URL, or HTTP on localhost, without credentials/query parameters.');
  return { baseUrl: baseUrl.replace(/\/+$/, ''), model: env.OPEN_TEAMMATES_MODEL || '', key: env.OPEN_TEAMMATES_API_KEY || '', ready: Boolean(env.OPEN_TEAMMATES_MODEL && (env.OPEN_TEAMMATES_API_KEY || local)), local };
}

export async function callModel({ role, mission, memory = [], message, history = [], json = false, env = process.env, fetchImpl = fetch }) {
  const config = modelConfig(env);
  if (!config.ready) throw new Error('Live mode needs OPEN_TEAMMATES_MODEL and OPEN_TEAMMATES_API_KEY (key optional for localhost). No provider request was made.');
  const payload = {
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt(role) },
      ...history.slice(-12).filter(item => ['user', 'assistant'].includes(item.role) && typeof item.content === 'string').map(item => ({ role: item.role, content: item.content.slice(0, 16000) })),
      { role: 'user', content: JSON.stringify({ mission, ownerPreferences: memory.map(item => item.text), assignment: message }) },
    ],
    max_completion_tokens: 8000,
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  };
  const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Model provider returned HTTP ${response.status}. Check the provider URL, model and credentials. No live draft was saved.`);
  const raw = await response.text();
  if (raw.length > 2_000_000) throw new Error('Model response exceeded the local size limit.');
  let result;
  try { result = JSON.parse(raw); } catch { throw new Error('Model provider returned invalid JSON.'); }
  const choice = result.choices?.[0];
  if (choice?.finish_reason === 'length') throw new Error('Model output was truncated. No live draft was saved.');
  const content = choice?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('Model provider returned no text.');
  return { content, usage: result.usage ?? null, model: config.model, provider: config.baseUrl };
}

export async function refineDrafts({ role, mission, memory, artifacts, env, fetchImpl }) {
  const prose = artifacts.filter(item => item.name.endsWith('.md'));
  const message = `Produce JSON only: {"documents":[{"name":"existing-name.md","content":"complete Markdown"}],"reflection":"remaining assumptions and next decisive step"}. Rewrite every supplied Markdown document as a thoughtful Chief of Events using this mission, the owner preferences and your DNA. Keep names identical. Preserve factual uncertainty, all explicit assumptions, the budget cap and calendar date. Keep CSV amounts, timeline and commitments authoritative; do not invent live research or confirmed contracts. Include candid tradeoffs, named accountable functional roles, a creative attendee experience, accessibility, downstream outcomes and a specific recommendation. Never change a CSV. Each document must stand alone and say Draft. Here is the draft pack: ${JSON.stringify(artifacts)}`;
  const result = await callModel({ role, mission, memory, message, json: true, env, fetchImpl });
  let data;
  try { data = JSON.parse(result.content); } catch { throw new Error('Model output did not match the JSON draft contract.'); }
  if (!Array.isArray(data.documents) || data.documents.length !== prose.length || typeof data.reflection !== 'string' || !data.reflection.trim() || data.reflection.length > 12000) throw new Error('Model output is missing complete documents or a reflection.');
  const allowed = new Set(prose.map(item => item.name));
  const documents = new Map();
  for (const doc of data.documents) {
    if (!doc || !allowed.has(doc.name) || documents.has(doc.name) || typeof doc.content !== 'string' || doc.content.length < 100 || doc.content.length > 60000) throw new Error('Model document name or content is invalid.');
    documents.set(doc.name, doc.content);
  }
  return {
    artifacts: artifacts.map(item => documents.has(item.name) ? { ...item, content: `> Draft: model-generated proposal. Verify details before execution.\n\n${documents.get(item.name)}` } : item),
    reflection: data.reflection,
    usage: result.usage,
    model: result.model,
    provider: result.provider,
  };
}
