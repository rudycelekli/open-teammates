#!/usr/bin/env node
/** Exercise a built tarball through npm and a real SDK stdio client, without a model. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, lstat, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, delimiter, basename, relative, isAbsolute } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execute = promisify(execFile);
const requestOptions = { timeout: 15000 };
let stage = 'validate tarball';

function within(parent, child) {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path);
}
async function jsonFile(path) { return JSON.parse(await readFile(path, 'utf8')); }

async function smoke() {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/smoke-package.mjs /absolute/path/open-teammates-VERSION.tgz');
  const tarball = resolve(process.argv[2]);
  assert.ok(tarball.endsWith('.tgz'), 'Supply the packed .tgz archive, not the source checkout.');
  assert.ok((await lstat(tarball)).isFile(), 'The package archive must be a regular file.');
  // Deliberately include a space: the installed CLI, workspace, and emitted MCP
  // arguments must work without shell interpolation or manual quoting.
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'open-teammates package smoke-')));
  let client;
  let transport;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined
    && !/^OPEN_TEAMMATES_/.test(key)
    && !/^(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY|INIT_CWD)$/.test(key)
    && !/^npm_(?:package_|lifecycle_|config_local_prefix$)/i.test(key)));
  env.PATH = [dirname(process.execPath), env.PATH ?? ''].join(delimiter);
  env.npm_config_cache = join(temporary, 'npm cache');
  env.npm_config_ignore_scripts = 'true';
  env.npm_config_audit = 'false';
  env.npm_config_fund = 'false';
  const npm = process.env.npm_execpath
    ? { command: process.execPath, prefix: [process.env.npm_execpath] }
    : { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [] };
  async function cli(args) {
    const { stdout } = await execute(npm.command, [...npm.prefix, 'exec', '--yes', '--package', tarball, '--', 'open-teammates', ...args], {
      cwd: temporary, env, encoding: 'utf8', timeout: 180000, maxBuffer: 4000000,
    });
    return JSON.parse(stdout);
  }
  try {
    stage = 'clean npm exec hire';
    const hired = await cli(['hire', 'chief-of-events', '--demo', '--dir', './mira', '--json']);
    const workspace = join(temporary, 'mira');
    assert.equal(hired.role.id, 'chief-of-events');
    assert.equal(hired.status, 'workspace_ready');
    assert.equal(hired.workspace, workspace);
    assert.equal(hired.mission.mode, 'template');
    assert.equal(hired.mission.artifacts.length, 8);
    const state = await jsonFile(join(workspace, 'state.json'));
    assert.equal(state.missions.length, 1);
    assert.equal(state.tasks.length, 12);
    assert.ok(state.tasks.every(task => task.status === 'open' && task.owner === null && task.evidence === null));
    const ids = new Set(state.tasks.map(task => task.id));
    assert.ok(state.tasks.flatMap(task => task.dependencies).every(id => ids.has(id)));
    for (const artifact of hired.mission.artifacts) {
      assert.ok(within(workspace, artifact.path), 'Installed artifacts must remain in the temporary workspace.');
      assert.equal(await readFile(artifact.path, 'utf8'), artifact.content);
    }

    stage = 'installed CLI briefing';
    const briefing = await cli(['briefing', '--dir', './mira', '--mission', hired.mission.id, '--json']);
    assert.equal(briefing.missions.length, 1);
    assert.equal(briefing.missions[0].readiness.status, 'needs_work');
    assert.ok(briefing.actions.length > 0);
    assert.match(briefing.markdown, /No actual outcome observations/);

    stage = 'project-local connect';
    const project = join(temporary, 'clean host project');
    await mkdir(project);
    const connected = await cli(['connect', '--project', project, '--dir', './mira', '--json']);
    const config = await jsonFile(join(project, '.mcp.json'));
    const entry = config.mcpServers['open-teammates-events'];
    assert.deepEqual(entry, connected.config);
    assert.ok(isAbsolute(entry.command));
    assert.ok(within(temporary, entry.args[0]), 'The MCP server must launch the tarball installation, not checkout code or a prior npm cache.');
    assert.deepEqual(entry.args.slice(1), ['mcp', '--dir', workspace]);
    assert.match(await readFile(join(project, '.teammates-chief-of-events.md'), 'utf8'), /Read MCP resources teammate:\/\/chief-of-events\/soul/);

    stage = 'offline evaluation plan';
    const plan = await cli(['eval', 'plan', '--out', './evaluation plan']);
    assert.equal(plan.mode, 'plan');
    assert.equal(plan.status, 'plan_ready');
    assert.equal(plan.caseIds.length, 8);
    assert.equal(plan.plannedProviderRequests, 0);
    assert.equal(plan.attemptedProviderRequests, 0);
    assert.equal(plan.successfulProviderRequests, 0);
    assert.equal(plan.evaluationStatus, 'unreviewed');
    assert.deepEqual(await jsonFile(join(temporary, 'evaluation plan', 'manifest.json')), plan);

    stage = 'installed CLI MCP SDK handshake';
    client = new Client({ name: 'open-teammates-installed-package-smoke', version: '1.0.0' });
    transport = new StdioClientTransport({ command: entry.command, args: entry.args, cwd: project, env, stderr: 'pipe', maxBufferSize: 2000000 });
    // Consume stderr without letting diagnostic output enter the JSON result or
    // filling a child-process pipe. SDK transport errors remain actual failures.
    transport.stderr?.on('data', () => {});
    await client.connect(transport, requestOptions);
    assert.equal(client.getServerVersion().name, 'open-teammates-chief-of-events');
    assert.equal(client.getServerVersion().version, plan.packageVersion);
    assert.match(client.getInstructions(), /read.*teammate:\/\/chief-of-events\/soul/i);
    const { tools } = await client.listTools(undefined, requestOptions);
    assert.ok(tools.some(tool => tool.name === 'teammate_status'));
    const result = await client.callTool({ name: 'teammate_status', arguments: { missionId: hired.mission.id } }, undefined, requestOptions);
    assert.notEqual(result.isError, true, 'The installed MCP status call failed.');
    const status = result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
    assert.equal(status.mission.id, hired.mission.id);
    assert.equal(status.tasks.length, 12);
    assert.equal(status.readiness.status, 'needs_work');
    assert.equal(status.readiness.authority, 'advisory_only');
    assert.equal(status.observations.length, 0);
    const { resources } = await client.listResources(undefined, requestOptions);
    for (const uri of ['teammate://chief-of-events/soul', 'teammate://chief-of-events/work-contract']) {
      assert.ok(resources.some(resource => resource.uri === uri));
      const resource = await client.readResource({ uri }, requestOptions);
      assert.ok(resource.contents.some(item => typeof item.text === 'string' && item.text.length > 100));
    }
    await client.close();
    client = null;
    transport = null;
    return {
      status: 'passed', package: basename(tarball), version: plan.packageVersion,
      checks: ['clean tarball npm exec', 'offline hire: 8 artifacts and 12 unresolved tasks', 'structured work briefing', 'project-local connection', 'offline evaluation plan: 8 cases', 'installed CLI MCP handshake, status, and role resources'],
      providerRequests: plan.attemptedProviderRequests,
      scope: 'Packaging, offline local work, and MCP protocol verified. Host personality adoption, live model judgment, and real event delivery are separate evaluations.',
    };
  } finally {
    if (client) await client.close().catch(() => {});
    if (transport) await transport.close().catch(() => {});
    await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

smoke().then(result => { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); }).catch(error => {
  process.stderr.write(`Package smoke failed at ${stage}: ${String(error.message).slice(0, 2000)}\n`);
  process.exitCode = 1;
});
