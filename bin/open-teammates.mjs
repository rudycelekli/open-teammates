#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStore } from '../src/store.mjs';
import { loadRole } from '../src/role.mjs';
import { DEMO_BRIEF, createMission } from '../src/events.mjs';
import { seedMissionTasks } from '../src/work.mjs';
import { runMission, askMira } from '../src/runtime.mjs';
import { modelConfig } from '../src/model.mjs';
import { exportRuntime } from '../src/export.mjs';
import { startServer } from '../src/server.mjs';
import { startMcp } from '../src/mcp.mjs';
import { hireRole, connectProject } from '../src/onboard.mjs';
import { buildBriefing } from '../src/briefing.mjs';
import { listEvaluationCases, runEvaluation, summarizeReviews } from '../src/evaluation.mjs';

const help = `Open Teammates 0.2.0 · Mira, Chief of Events

Usage: open-teammates <command> [options]

  hire chief-of-events         Install Mira's local role and work ledger
  demo                         Offline fictional event pack and work graph
  run --brief FILE             Draft an event pack and suggested work
  redraft MISSION_ID           Regenerate a pack for the current brief
  revise MISSION_ID --patch FILE --reason TEXT --expected-revision N
                               Revise a brief, invalidating stale work and handoffs
  briefing                     Read Mira's current work briefing
  next                         Prioritized, on-demand next useful work
  ask "assignment"             Model consultation with revision-scoped history
  task list|seed|add|update     Work graph; add/update take --input/--patch FILE
  decision list|add|review      Decision proposals and owner review (--input FILE)
  outcome list|add              Actual observations with source and time (--input FILE)
  memory add|list|confirm|delete
                               Owner preferences and review of proposed memory
  handoff list|request|approve|reject
                               Review concrete requests; no external execution
  connect --project DIR        Add a project-local MCP entry without overwriting others
  mcp                          Start the stdio MCP work server
  start                        Start the local workspace API on loopback
  export --runtime HOST --out DIR
                               Export Mira for an existing agent host
  eval list                    Eight fixed judgment scenarios
  eval plan --out DIR          Prepare matched baseline/Mira prompts, offline
  eval run --out DIR --case ID --live
                               Two model requests for one case, outputs unreviewed
  eval summarize --input FILE  Summarize explicit independent human reviews
  roles                        Available and proposed employees
  doctor                       Configuration check without provider calls

Options:
  --dir DIR                    Workspace (default .teammates in current directory)
  --demo                       Seed a fictional assignment when hiring
  --organization NAME          Organization name for hire
  --mission UUID               Filter/context for work and ask commands
  --live                       Explicit model calls; enables them on start
  --expected-revision N        Required for revise/task update, latest revision to edit
  --input FILE                 JSON input for work records
  --patch FILE                 JSON patch for brief or task
  --project DIR                Optional host project to connect when hiring
  --runtime HOST               generic, hermes, openclaw, pi, open-dots, open-instinct
  --port PORT                  Local API port (default 4317)
  --force                      Replace conflicting exported bundle files
  --json                       Structured output for briefing
  --help                       Show this help

Model: OPEN_TEAMMATES_MODEL + OPEN_TEAMMATES_API_KEY; optional
OPEN_TEAMMATES_BASE_URL (default https://api.openai.com/v1).
MCP tools run local work with your host's model and never call this provider.
MIT-licensed source: https://github.com/rudycelekli/open-teammates
npm registry publishing is pending.
`;
function parse(args) {
  const options = {}, positionals = [];
  const flags = new Set(['live', 'force', 'help', 'demo', 'json']);
  const values = new Set(['dir', 'brief', 'runtime', 'out', 'mission', 'port', 'project', 'organization', 'patch', 'reason', 'expected-revision', 'input', 'case']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const key = arg.slice(2);
    if (flags.has(key)) options[key] = true;
    else if (values.has(key)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`--${key} requires a value.`);
      options[key] = args[++i];
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return { options, positionals };
}
const print = value => console.log(JSON.stringify(value, null, 2));
async function jsonFile(path, flag) { if (!path) throw new Error(`${flag} requires a JSON file.`); return JSON.parse(await readFile(resolve(path), 'utf8')); }
function expectedRevision(options) { const value = Number(options['expected-revision']); if (!Number.isSafeInteger(value) || value < 1) throw new Error('Supply --expected-revision with the current positive integer revision.'); return value; }
function printMission(mission, root) {
  console.log(`\nMira · Chief of Events\n${mission.name}\n\n${mission.mode === 'live' ? 'Live model draft' : 'Offline template draft'} · ${mission.artifacts.length} artifacts · ${mission.currency} ${mission.budget.toLocaleString('en-US')} budget ceiling\nMission: ${mission.id} · brief revision ${mission.revision} · draft version ${mission.draftVersion}\n`);
  for (const artifact of mission.artifacts) console.log(`  ${artifact.title}\n  ${artifact.path}\n`);
  console.log(`Next: open-teammates briefing --dir "${root}"\nStructural review: ${mission.review.passed ? 'passed' : 'needs work'}. Professional judgment remains unmeasured.\n`);
}
export async function main(args = process.argv.slice(2)) {
  const { options, positionals } = parse(args);
  const command = positionals.shift() || 'help';
  if (options.help || command === 'help') { console.log(help); return; }
  const dir = resolve(options.dir || '.teammates');
  if (command === 'doctor') {
    const config = modelConfig();
    print({ version: '0.2.0', node: process.version, supportedNode: Number(process.versions.node.split('.')[0]) >= 22, localWork: 'ready', mcp: 'SDK installed', model: config.model || null, provider: config.baseUrl, live: config.ready ? 'configured, connection untested' : 'not configured', published: false }); return;
  }
  if (command === 'roles') {
    const role = await loadRole();
    console.log(`${role.name} · ${role.title}\n${role.mission}\n\nAvailable: chief-of-events\nProposed: Chief of Staff, Developer Relations, Partnerships, Research.`); return;
  }
  if (command === 'export') {
    if (!options.runtime || !options.out) throw new Error('export requires --runtime HOST and --out DIR.');
    print(await exportRuntime({ runtime: options.runtime, out: resolve(options.out), force: Boolean(options.force) })); return;
  }
  if (command === 'eval') {
    const action = positionals.shift();
    if (action === 'list') print(await listEvaluationCases());
    else if (action === 'plan') { if (options.live) throw new Error('Planning is offline. Use eval run for explicit model calls.'); print(await runEvaluation({ out: options.out, caseId: options.case })); }
    else if (action === 'run') { if (!options.live) throw new Error('eval run requires --live and makes two provider requests for one --case.'); print(await runEvaluation({ out: options.out, caseId: options.case, live: true })); }
    else if (action === 'summarize') print(summarizeReviews(await jsonFile(options.input, '--input')));
    else throw new Error('Use eval list, plan, run, or summarize.'); return;
  }
  if (command === 'hire') {
    const result = await hireRole({ dir, roleId: positionals[0] || 'chief-of-events', runtime: options.runtime || 'generic', organization: options.organization, brief: options.brief ? await jsonFile(options.brief, '--brief') : undefined, demo: Boolean(options.demo) });
    if (options.project) result.connection = await connectProject({ project: options.project, store: await createStore(dir) });
    if (options.json) print(result);
    else {
      console.log(`Mira · Chief of Events\n\nWorkspace ready: ${result.workspace}\nRole bundle: ${result.bundle.out}\n${result.mission ? `First mission: ${result.mission.name} (${result.mission.id})\n${result.mission.artifacts.length} planning artifacts and a suggested work graph are ready.\n` : ''}\nRead the work: open-teammates briefing --dir "${result.workspace}"\nHost instructions: ${result.bundle.out}/INTEGRATION.md\n${result.connection ? `MCP configured for project: ${result.connection.project}\n` : 'Connect your host: open-teammates connect --project ./your-project --dir "' + result.workspace + '"\n'}\nLocal setup complete. The chosen host runs the teammate; no background service was started.`);
    }
    return;
  }
  if (!['init', 'demo', 'run', 'redraft', 'revise', 'ask', 'start', 'memory', 'task', 'decision', 'outcome', 'handoff', 'connect', 'mcp', 'briefing', 'next'].includes(command)) throw new Error(`Unknown command: ${command}. Use --help.`);
  const store = await createStore(dir);
  if (command === 'init') {
    await store.record('workspace.initialized', { role: 'chief-of-events' });
    console.log(`Mira's workspace is ready at ${store.root}\nUse hire chief-of-events to install the role bundle or demo for the first assignment.`);
  } else if (command === 'demo' || command === 'run') {
    if (command === 'demo' && options.live) throw new Error('Demo stays offline. Use run --brief FILE --live for a model-backed assignment.');
    if (options.live && !modelConfig().ready) throw new Error('Configure your model before live drafting.');
    const brief = command === 'demo' ? DEMO_BRIEF : await jsonFile(options.brief, '--brief');
    seedMissionTasks(createMission(brief));
    const mission = await store.addMission(brief); await store.seedTasks(mission.id);
    printMission(await runMission(store, mission.id, { live: Boolean(options.live) }), store.root);
  } else if (command === 'redraft') {
    printMission(await runMission(store, positionals[0] || options.mission, { live: Boolean(options.live) }), store.root);
  } else if (command === 'revise') {
    if (!options.reason) throw new Error('Revision requires --reason describing the change.');
    print(await store.updateMission(positionals[0] || options.mission, await jsonFile(options.patch, '--patch'), { expectedRevision: expectedRevision(options), reason: options.reason }));
  } else if (command === 'briefing') {
    const briefing = buildBriefing(store, { missionId: options.mission });
    if (options.json) print(briefing); else console.log(briefing.markdown);
  } else if (command === 'next') {
    const briefing = buildBriefing(store, { missionId: options.mission }); print(briefing.actions.slice(0, 20));
  } else if (command === 'ask') {
    console.log((await askMira(store, positionals.join(' '), { missionId: options.mission })).reply);
  } else if (command === 'memory') {
    const sub = positionals.shift();
    if (sub === 'add') print(await store.addMemory(positionals.join(' ')));
    else if (sub === 'list') print(store.snapshot().memory);
    else if (sub === 'confirm') print(await store.confirmMemory(positionals[0]));
    else if (sub === 'delete') print(await store.deleteMemory(positionals[0]));
    else throw new Error('Use memory add, list, confirm, or delete.');
  } else if (command === 'task') {
    const sub = positionals.shift();
    if (sub === 'list') print(store.snapshot().tasks.filter(t => !options.mission || t.missionId === options.mission));
    else if (sub === 'seed') print(await store.seedTasks(positionals[0] || options.mission));
    else if (sub === 'add') { const input = await jsonFile(options.input, '--input'); print(await store.addTask({ ...input, missionId: options.mission || input.missionId })); }
    else if (sub === 'update') print(await store.updateTask(positionals[0], await jsonFile(options.patch, '--patch'), { expectedRevision: expectedRevision(options) }));
    else throw new Error('Use task list, seed, add, or update.');
  } else if (command === 'decision') {
    const sub = positionals.shift();
    if (sub === 'list') print(store.snapshot().decisions.filter(d => !options.mission || d.missionId === options.mission));
    else if (sub === 'add') { const input = await jsonFile(options.input, '--input'); print(await store.recordDecision({ ...input, missionId: options.mission || input.missionId })); }
    else if (sub === 'review') print(await store.decideDecision(positionals[0], await jsonFile(options.input, '--input')));
    else throw new Error('Use decision list, add, or review.');
  } else if (command === 'outcome') {
    const sub = positionals.shift();
    if (sub === 'list') print(store.snapshot().observations.filter(o => !options.mission || o.missionId === options.mission));
    else if (sub === 'add') { const input = await jsonFile(options.input, '--input'); print(await store.addObservation({ ...input, missionId: options.mission || input.missionId })); }
    else throw new Error('Use outcome list or add.');
  } else if (command === 'handoff') {
    const sub = positionals.shift();
    if (sub === 'list') print(store.snapshot().approvals);
    else if (sub === 'request') print(await store.requestAction(await jsonFile(options.input, '--input')));
    else if (sub === 'approve' || sub === 'reject') print(await store.decideAction(positionals[0], sub === 'approve' ? 'approve' : 'reject'));
    else throw new Error('Use handoff list, request, approve, or reject.');
  } else if (command === 'connect') print(await connectProject({ project: options.project, store }));
  else if (command === 'mcp') {
    const handle = await startMcp(store);
    process.on('SIGINT', () => handle.close().then(() => process.exit(0)));
    process.on('SIGTERM', () => handle.close().then(() => process.exit(0)));
  } else if (command === 'start') {
    if (options.live && !modelConfig().ready) throw new Error('Configure a model before starting with --live.');
    const { server, url } = await startServer(store, { port: options.port === undefined ? 4317 : Number(options.port), allowLive: Boolean(options.live) });
    console.log(`Mira's local API: ${url}\nWorkspace: ${store.root}\nMode: ${options.live ? 'live enabled' : 'offline templates'}\nPress Ctrl+C to stop.`);
    const close = () => server.close(() => process.exit(0)); process.on('SIGINT', close); process.on('SIGTERM', close);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch(error => { console.error(`Open Teammates: ${error.message}`); process.exitCode = 1; });
