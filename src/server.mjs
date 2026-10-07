import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { loadRole, packageRoot } from './role.mjs';
import { runMission, askMira } from './runtime.mjs';
import { modelConfig } from './model.mjs';
import { buildBriefing } from './briefing.mjs';
import { createMission } from './events.mjs';
import { seedMissionTasks } from './work.mjs';

const staticFiles = new Map([['/', ['index.html', 'text/html']], ['/app.mjs', ['app.mjs', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);
function expectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('expectedRevision is required and must be a positive safe integer. Refresh the current record before editing.');
  return value;
}
export async function startServer(store, { port = 4317, allowLive = false, env = process.env } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer between 0 and 65535.');
  const token = randomBytes(32).toString('hex');
  const role = await loadRole();
  const config = modelConfig(env);
  const activeRuns = new Set();
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      const actualPort = server.address().port;
      const hosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
      if (!hosts.includes(req.headers.host)) return send(403, { error: 'Local host required.' });
      if (req.headers.origin && !hosts.map(host => `http://${host}`).includes(req.headers.origin)) return send(403, { error: 'Same-origin requests only.' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Cross-site requests are blocked.' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/api/session') return send(200, { token });
      if (url.pathname.startsWith('/api/')) {
        const supplied = req.headers['x-teammates-token'];
        if (typeof supplied !== 'string' || supplied.length !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) return send(401, { error: 'A local session token is required.' });
        if (req.method === 'GET' && url.pathname === '/api/state') return send(200, {
          ...store.snapshot(), role,
          runtime: { version: '0.2.0', workspace: store.root, mode: allowLive && config.ready ? 'live_available' : 'template', liveEnabled: Boolean(allowLive && config.ready), model: config.model || null },
          capabilities: { planning: true, localMemory: true, draftArtifacts: true, workGraph: true, revisions: true, mcp: true, realWorldExecution: false, backgroundMonitoring: false },
        });
        if (req.method === 'GET' && url.pathname === '/api/briefing') return send(200, buildBriefing(store, { missionId: url.searchParams.get('missionId') || undefined }));
        if (req.method === 'GET' && url.pathname.startsWith('/api/artifacts/')) {
          const parts = url.pathname.split('/');
          if (parts.length !== 5) return send(404, { error: 'Artifact not found.' });
          const artifact = store.getMission(parts[3]).artifacts.find(item => item.name === decodeURIComponent(parts[4]));
          if (!artifact) return send(404, { error: 'Artifact not found.' });
          res.writeHead(200, { 'Content-Type': artifact.name.endsWith('.csv') ? 'text/csv; charset=utf-8' : 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${artifact.name}"` });
          return res.end(artifact.content);
        }
        if (!['POST', 'DELETE'].includes(req.method)) return send(405, { error: 'Method not allowed.' });
        let body = '';
        for await (const chunk of req) {
          body += chunk.toString();
          if (Buffer.byteLength(body) > 64000) return send(413, { error: 'Request is too large.' });
        }
        let data;
        try { data = body ? JSON.parse(body) : {}; } catch { return send(400, { error: 'Invalid JSON body.' }); }
        if (req.method === 'POST' && url.pathname === '/api/missions') {
          // Validate the whole dated work plan before committing the mission itself.
          seedMissionTasks(createMission(data));
          const mission = await store.addMission(data);
          await store.seedTasks(mission.id);
          return send(201, mission);
        }
        const revise = url.pathname.match(/^\/api\/missions\/([a-f0-9-]+)\/revise$/);
        if (req.method === 'POST' && revise) return send(200, await store.updateMission(revise[1], data.patch, { expectedRevision: expectedRevision(data.expectedRevision), reason: data.reason }));
        if (req.method === 'POST' && url.pathname === '/api/tasks') return send(201, await store.addTask(data));
        const task = url.pathname.match(/^\/api\/tasks\/([a-f0-9-]+)$/);
        if (req.method === 'POST' && task) return send(200, await store.updateTask(task[1], data.patch, { expectedRevision: expectedRevision(data.expectedRevision) }));
        if (req.method === 'POST' && url.pathname === '/api/decisions') return send(201, await store.recordDecision(data));
        if (req.method === 'POST' && url.pathname === '/api/outcomes') return send(201, await store.addObservation(data));
        const confirmMemory = url.pathname.match(/^\/api\/memory\/([a-f0-9-]+)\/confirm$/);
        if (req.method === 'POST' && confirmMemory) return send(200, await store.confirmMemory(confirmMemory[1]));
        const run = url.pathname.match(/^\/api\/missions\/([a-f0-9-]+)\/run$/);
        if (req.method === 'POST' && run) {
          if (data.mode && !['template', 'live'].includes(data.mode)) throw new Error('Mode must be template or live.');
          if (data.mode === 'live' && !(allowLive && config.ready)) return send(409, { error: 'Start with --live and configure a model to enable live drafts.' });
          if (activeRuns.has(run[1])) return send(409, { error: 'This mission is already drafting.' });
          activeRuns.add(run[1]);
          try { return send(200, await runMission(store, run[1], { live: data.mode === 'live', env })); }
          finally { activeRuns.delete(run[1]); }
        }
        if (req.method === 'POST' && url.pathname === '/api/chat') {
          if (!(allowLive && config.ready)) return send(409, { error: 'Chat requires a configured model and startup with --live.' });
          return send(200, await askMira(store, data.message, { missionId: data.missionId, env }));
        }
        if (req.method === 'POST' && url.pathname === '/api/memory') return send(201, await store.addMemory(data.text));
        const memory = url.pathname.match(/^\/api\/memory\/([a-f0-9-]+)$/);
        if (req.method === 'DELETE' && memory) return send(200, await store.deleteMemory(memory[1]));
        if (req.method === 'POST' && url.pathname === '/api/actions') return send(201, await store.requestAction(data));
        const approval = url.pathname.match(/^\/api\/approvals\/([a-f0-9-]+)$/);
        if (req.method === 'POST' && approval) return send(200, await store.decideAction(approval[1], data.decision));
        return send(404, { error: 'API route not found.' });
      }
      if (req.method === 'GET' && staticFiles.has(url.pathname)) {
        const [file, type] = staticFiles.get(url.pathname);
        try {
          const content = await readFile(new URL(`public/${file}`, packageRoot));
          res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
          return res.end(content);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end(`Open Teammates: Mira, Chief of Events\n\nThe first release is CLI-first.\nWorkspace: ${store.root}\n\nUse open-teammates demo to generate an event planning pack.\n`);
        }
      }
      send(404, { error: 'Not found.' });
    } catch (error) { send(400, { error: error.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
