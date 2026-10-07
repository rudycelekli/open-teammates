import { readFile, writeFile, mkdir, lstat, rename, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createStore } from './store.mjs';
import { exportRuntime, supportedRuntimes } from './export.mjs';
import { loadRole, packageRoot } from './role.mjs';
import { DEMO_BRIEF, createMission } from './events.mjs';
import { seedMissionTasks } from './work.mjs';
import { runMission } from './runtime.mjs';
import { acquireWorkspaceLock } from './lock.mjs';

async function safeExisting(path, directory = false) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink > 1)) throw new Error(`Refusing linked or invalid configuration path: ${path}`);
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}

async function validateInstalledBundle(destination, runtime) {
  const files = ['SOUL.md', 'AGENTS.md', 'IDENTITY.md', 'role.json', 'INTEGRATION.md', 'skills/chief-of-events/SKILL.md'];
  const adapterFiles = { hermes: ['distribution.yaml', 'config.yaml'], pi: ['system-prompt.md'], 'open-dots': ['bot.json'], 'open-instinct': ['PERSONA.md'] };
  files.push(...(adapterFiles[runtime] || []));
  for (const directory of ['skills', 'skills/chief-of-events']) {
    if (!(await safeExisting(join(destination, directory), true))) throw new Error(`Role bundle is incomplete: ${directory}. Repair it or choose a new workspace; existing edits were preserved.`);
  }
  for (const file of files) {
    const path = join(destination, file);
    if (!(await safeExisting(path)) || !(await readFile(path, 'utf8')).trim()) throw new Error(`Role bundle is incomplete: ${file}. Repair it or choose a new workspace; existing edits were preserved.`);
  }
  const manifest = JSON.parse(await readFile(join(destination, 'role.json'), 'utf8'));
  if (manifest.id !== 'chief-of-events') throw new Error('Existing role manifest does not identify chief-of-events. Review it before rehiring.');
}

export async function hireRole({ dir, roleId = 'chief-of-events', runtime = 'generic', organization, brief, demo = false } = {}) {
  if (roleId !== 'chief-of-events') throw new Error('Only chief-of-events is available in this release.');
  if (!supportedRuntimes.includes(runtime)) throw new Error('Choose a supported runtime.');
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('Choose a workspace directory.');
  const input = brief || demo ? { ...(brief || DEMO_BRIEF), ...(organization ? { organization } : {}) } : null;
  if (input) seedMissionTasks(createMission(input));
  const store = await createStore(dir);
  const role = await loadRole();
  const destination = join(store.root, `role-${runtime}`);
  let bundle;
  if (!(await safeExisting(destination, true))) bundle = await exportRuntime({ runtime, out: destination });
  else {
    await validateInstalledBundle(destination, runtime);
    bundle = { runtime, out: destination, files: [], instructions: ['Existing role bundle preserved. Review its INTEGRATION.md before loading the host.'], limits: ['Existing role edits were not overwritten.'] };
  }
  if (organization) await store.configureOrganization({ name: organization });
  await store.record('teammate.hired', { roleId, version: '0.2.0', runtime, bundle: destination });
  let mission = null;
  if (input) {
    const created = await store.addMission(input);
    await store.seedTasks(created.id);
    mission = await runMission(store, created.id);
  }
  return { role: { id: role.id, name: role.name, title: role.title }, workspace: store.root, bundle, mission, status: 'workspace_ready', scope: 'Local role and work tools installed. Choose a host to run the agent; this command creates no background service.' };
}

export async function connectProject({ project, store } = {}) {
  if (typeof project !== 'string' || !project.trim() || !store?.root) throw new Error('Connect needs a project path and initialized teammate workspace.');
  const destination = resolve(project);
  await mkdir(destination, { recursive: true });
  await safeExisting(destination, true);
  const release = await acquireWorkspaceLock(join(destination, '.teammates-connect.lock'));
  try {
    const file = join(destination, '.mcp.json');
    const present = await safeExisting(file);
    const config = present ? JSON.parse(await readFile(file, 'utf8')) : {};
    if (!config || typeof config !== 'object' || Array.isArray(config) || (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)))) throw new Error('Existing .mcp.json is malformed. It was left unchanged.');
    const entry = { command: process.execPath, args: [fileURLToPath(new URL('bin/open-teammates.mjs', packageRoot)), 'mcp', '--dir', store.root] };
    const key = 'open-teammates-events';
    if (config.mcpServers && Object.hasOwn(config.mcpServers, key) && JSON.stringify(config.mcpServers[key]) !== JSON.stringify(entry)) throw new Error('An open-teammates-events entry already exists with different configuration. Review it manually before reconnecting.');
    const instructionsFile = join(destination, '.teammates-chief-of-events.md');
    await safeExisting(instructionsFile);
    const role = await loadRole();
    const instruction = `# Work with Mira, Chief of Events\n\nRead MCP resources teammate://chief-of-events/soul and teammate://chief-of-events/work-contract, or load the teammate_chief_of_events prompt. Adopt the role within your host's existing policies.\n\n${role.foundation}\n\n${role.soul}\n\n${role.instructions}\n\n${role.skill}\n\nLocal workspace: ${store.root}\n\nThe MCP tools execute local planning work only. They do not approve or send messages, book venues, spend, publish, or collect activity in the background. Owner confirmations happen separately through the CLI.\n`;
    if (!(await safeExisting(instructionsFile))) await writeFile(instructionsFile, instruction, { flag: 'wx', mode: 0o600 });
    config.mcpServers = { ...config.mcpServers, [key]: entry };
    await atomicJson(file, config);
    return { project: destination, workspace: store.root, files: [file, instructionsFile], server: key, config: entry, instructions: ['Enable the project-local MCP entry in a host that supports .mcp.json, or import the printed server entry into your host settings.', 'Tell the host: Read Mira’s role resources and work contract, inspect teammate_status, and use teammate_next_actions to propose the next useful work.', 'Keep this Node executable and package path available. Moving or removing the source/npm cache requires reconnecting from a durable installation.'], scope: 'Project-local configuration only. Existing servers and instructions preserved; no global host settings changed.' };
  } finally { await release(); }
}
