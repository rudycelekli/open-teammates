import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, link, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { connectProject, hireRole } from '../src/onboard.mjs';
import { createStore } from '../src/store.mjs';
import { DEMO_BRIEF } from '../src/events.mjs';

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'open-teammates-onboard-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('hire creates a portable role and empty private work ledger without claiming a running host', async t => {
  const directory = await workspace(t);
  const dir = join(directory, 'teammate');
  const hired = await hireRole({ dir, organization: 'Fictional Events Company' });
  assert.equal(hired.role.id, 'chief-of-events');
  assert.equal(hired.role.name, 'Mira');
  assert.equal(hired.workspace, dir);
  assert.equal(hired.status, 'workspace_ready');
  assert.equal(hired.mission, null);
  assert.match(hired.scope, /no background service/);
  assert.equal(hired.bundle.runtime, 'generic');
  assert.ok(hired.bundle.files.includes('SOUL.md'));
  assert.ok(hired.bundle.files.includes('skills/chief-of-events/SKILL.md'));
  assert.ok((await readFile(join(hired.bundle.out, 'SOUL.md'), 'utf8')).includes('Mira'));
  const state = (await createStore(dir)).snapshot();
  assert.equal(state.organization.name, 'Fictional Events Company');
  assert.equal(state.missions.length, 0);
  assert.equal(state.tasks.length, 0);
  assert.equal(state.observations.length, 0);
  assert.ok(state.audit.some(record => record.type === 'teammate.hired'));
  assert.equal(await readFile(join(dir, '.gitignore'), 'utf8'), '*\n');
});

test('a demo hire saves fictional offline artifacts and unresolved evidence-led work', async t => {
  const directory = await workspace(t);
  const hired = await hireRole({ dir: join(directory, 'teammate'), demo: true, organization: 'Fictional Demo Company' });
  const state = (await createStore(hired.workspace)).snapshot();
  assert.equal(state.missions.length, 1);
  assert.equal(hired.mission.organization, 'Fictional Demo Company');
  assert.equal(hired.mission.mode, 'template');
  assert.equal(hired.mission.runs.length, 1);
  assert.ok(hired.mission.artifacts.length >= 8);
  assert.equal(state.tasks.length, 12);
  assert.ok(state.tasks.every(task => task.status === 'open' && task.owner === null && task.evidence === null));
  assert.equal(state.observations.length, 0);
  assert.equal(state.approvals.length, 0);
  assert.equal(state.conversations.length, 0);
});

test('a supplied brief becomes a seeded local mission and keeps its cap and timezone', async t => {
  const directory = await workspace(t);
  const hired = await hireRole({
    dir: join(directory, 'teammate'), runtime: 'hermes',
    brief: { ...DEMO_BRIEF, name: 'Fictional Regional Forum', format: 'regional', budget: 64000, date: '2027-10-14', timezone: 'Asia/Tokyo' },
  });
  assert.equal(hired.mission.name, 'Fictional Regional Forum');
  assert.equal(hired.mission.budget, 64000);
  assert.equal(hired.mission.timezone, 'Asia/Tokyo');
  assert.equal(hired.mission.mode, 'template');
  assert.ok(hired.bundle.files.includes('distribution.yaml'));
  assert.equal((await createStore(hired.workspace)).snapshot().tasks.length, 12);
});

test('rehiring preserves owner-edited role files and creates no accidental mission', async t => {
  const directory = await workspace(t);
  const dir = join(directory, 'teammate');
  const first = await hireRole({ dir });
  const soul = join(first.bundle.out, 'SOUL.md');
  await writeFile(soul, '# Owner-reviewed local personality additions\n');
  const second = await hireRole({ dir });
  assert.equal(await readFile(soul, 'utf8'), '# Owner-reviewed local personality additions\n');
  assert.deepEqual(second.bundle.files, []);
  assert.equal(second.mission, null);
  assert.equal((await createStore(dir)).snapshot().missions.length, 0);
});

test('unsupported hires are rejected before mutating an existing ledger, including an existing bundle directory', async t => {
  const directory = await workspace(t);
  const dir = join(directory, 'teammate');
  const store = await createStore(dir);
  await store.configureOrganization({ name: 'Original Fictional Company' });
  await mkdir(join(dir, 'role-invented'));
  const before = await readFile(join(dir, 'state.json'), 'utf8');
  await assert.rejects(hireRole({ dir, runtime: 'invented', organization: 'Wrong Replacement Company' }), /supported runtime/i);
  assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), before);
  await assert.rejects(hireRole({ dir, roleId: 'chief-of-staff' }), /Only chief-of-events/);
});

test('incomplete or linked existing role bundles cannot claim a successful installation', async t => {
  const directory = await workspace(t);
  const emptyDir = join(directory, 'empty');
  const emptyStore = await createStore(emptyDir);
  await emptyStore.configureOrganization({ name: 'Original organization' });
  await mkdir(join(emptyDir, 'role-generic'));
  const before = await readFile(join(emptyDir, 'state.json'), 'utf8');
  await assert.rejects(hireRole({ dir: emptyDir, organization: 'Must not overwrite' }), /bundle is incomplete/);
  assert.equal(await readFile(join(emptyDir, 'state.json'), 'utf8'), before);
  const hired = await hireRole({ dir: join(directory, 'partial'), runtime: 'hermes' });
  await rm(join(hired.bundle.out, 'distribution.yaml'));
  await assert.rejects(hireRole({ dir: hired.workspace, runtime: 'hermes' }), /distribution.yaml/);
  const generic = await hireRole({ dir: join(directory, 'linked') });
  await rm(join(generic.bundle.out, 'SOUL.md'));
  const outside = join(directory, 'outside-soul.md');
  await writeFile(outside, '# External role content');
  await symlink(outside, join(generic.bundle.out, 'SOUL.md'));
  await assert.rejects(hireRole({ dir: generic.workspace }), /linked or invalid/);
});

test('unseedable hire brief fails before creating a workspace or recording an installation', async t => {
  const directory = await workspace(t);
  const dir = join(directory, 'unseedable');
  await assert.rejects(hireRole({ dir, brief: { ...DEMO_BRIEF, date: '0000-01-01' } }), /supported calendar range/);
  assert.ok(!(await readdir(directory)).includes('unseedable'));
});

test('connect emits absolute launch arguments and preserves unrelated project MCP settings', async t => {
  const directory = await workspace(t);
  const project = join(directory, 'project');
  await mkdir(project);
  const original = {
    ownerNote: 'Keep this project configuration.',
    mcpServers: { other: { command: 'fictional-other-server', args: ['--example'], env: { EXAMPLE: 'nonsecret-test-setting' } } },
  };
  await writeFile(join(project, '.mcp.json'), JSON.stringify(original));
  const store = await createStore(join(directory, 'teammate'));
  const connected = await connectProject({ project, store });
  const config = JSON.parse(await readFile(join(project, '.mcp.json'), 'utf8'));
  assert.equal(config.ownerNote, original.ownerNote);
  assert.deepEqual(config.mcpServers.other, original.mcpServers.other);
  assert.deepEqual(config.mcpServers[connected.server], connected.config);
  assert.equal(connected.config.command, process.execPath);
  assert.ok(isAbsolute(connected.config.args[0]));
  assert.equal(connected.config.args[1], 'mcp');
  assert.deepEqual(connected.config.args.slice(2), ['--dir', store.root]);
  assert.deepEqual(connected.files, [join(project, '.mcp.json'), join(project, '.teammates-chief-of-events.md')]);
  assert.ok(connected.instructions.length >= 2);
  assert.equal(Object.hasOwn(connected.config, 'env'), false);
  assert.ok(!(await readdir(project)).includes('.teammates-connect.lock'));
});

test('reconnecting is idempotent and preserves existing local instructions', async t => {
  const directory = await workspace(t);
  const project = join(directory, 'project');
  const store = await createStore(join(directory, 'teammate'));
  const first = await connectProject({ project, store });
  const instructions = join(project, '.teammates-chief-of-events.md');
  await writeFile(instructions, '# Project-specific owner instructions\n');
  const before = await readFile(join(project, '.mcp.json'), 'utf8');
  const second = await connectProject({ project, store });
  assert.deepEqual(second.config, first.config);
  assert.equal(await readFile(join(project, '.mcp.json'), 'utf8'), before);
  assert.equal(await readFile(instructions, 'utf8'), '# Project-specific owner instructions\n');
});

test('any existing conflicting server value is refused without touching project config', async t => {
  const directory = await workspace(t);
  const store = await createStore(join(directory, 'teammate'));
  for (const [index, conflict] of [{ command: 'some-other-installation', args: [] }, null, false, ''].entries()) {
    await t.test(`conflict ${index}`, async () => {
      const project = join(directory, `project-${index}`);
      await mkdir(project);
      const config = JSON.stringify({ mcpServers: { 'open-teammates-events': conflict, other: { command: 'keep-me' } } });
      await writeFile(join(project, '.mcp.json'), config);
      await assert.rejects(connectProject({ project, store }), /already exists with different configuration/);
      assert.equal(await readFile(join(project, '.mcp.json'), 'utf8'), config);
      assert.ok(!(await readdir(project)).includes('.teammates-chief-of-events.md'));
    });
  }
});

test('malformed project config is rejected and left byte-for-byte unchanged', async t => {
  const directory = await workspace(t);
  const store = await createStore(join(directory, 'teammate'));
  for (const [index, config] of ['broken JSON', '[]', '{"mcpServers":[]}', '{"mcpServers":null}'].entries()) {
    await t.test(`malformed ${index}`, async () => {
      const project = join(directory, `project-${index}`);
      await mkdir(project);
      await writeFile(join(project, '.mcp.json'), config);
      await assert.rejects(connectProject({ project, store }));
      assert.equal(await readFile(join(project, '.mcp.json'), 'utf8'), config);
      assert.ok(!(await readdir(project)).includes('.teammates-connect.lock'));
    });
  }
});

test('project, config and instruction symlinks cannot redirect writes outside the project', async t => {
  const directory = await workspace(t);
  const store = await createStore(join(directory, 'teammate'));
  const outside = join(directory, 'outside');
  await mkdir(outside);
  const linkedProject = join(directory, 'linked-project');
  await symlink(outside, linkedProject);
  await assert.rejects(connectProject({ project: linkedProject, store }), /linked or invalid configuration path/);
  assert.deepEqual(await readdir(outside), []);
  for (const [index, filename] of ['.mcp.json', '.teammates-chief-of-events.md'].entries()) {
    await t.test(filename, async () => {
      const project = join(directory, `project-${index}`);
      await mkdir(project);
      const target = join(outside, `target-${index}.txt`);
      const original = filename === '.mcp.json' ? '{"mcpServers":{}}' : '# Do not modify external instructions\n';
      await writeFile(target, original);
      await symlink(target, join(project, filename));
      await assert.rejects(connectProject({ project, store }), /linked or invalid configuration path/);
      assert.equal(await readFile(target, 'utf8'), original);
      assert.ok(!(await readdir(project)).includes('.teammates-connect.lock'));
    });
  }
});

test('hardlinked MCP config and nonregular instruction paths are refused', async t => {
  const directory = await workspace(t);
  const store = await createStore(join(directory, 'teammate'));
  const project = join(directory, 'project');
  await mkdir(project);
  const external = join(directory, 'external.json');
  await writeFile(external, '{"mcpServers":{}}');
  await link(external, join(project, '.mcp.json'));
  await assert.rejects(connectProject({ project, store }), /linked or invalid configuration path/);
  assert.equal(await readFile(external, 'utf8'), '{"mcpServers":{}}');
  await rm(join(project, '.mcp.json'));
  await mkdir(join(project, '.teammates-chief-of-events.md'));
  await assert.rejects(connectProject({ project, store }), /linked or invalid configuration path/);
  assert.ok(!(await readdir(project)).includes('.mcp.json'));
});

test('competing project connects retain other servers and produce one usable entry', async t => {
  const directory = await workspace(t);
  const project = join(directory, 'project');
  await mkdir(project);
  await writeFile(join(project, '.mcp.json'), '{"mcpServers":{"other":{"command":"keep-me"}}}');
  const store = await createStore(join(directory, 'teammate'));
  const results = await Promise.all([connectProject({ project, store }), connectProject({ project, store })]);
  assert.deepEqual(results[0].config, results[1].config);
  const config = JSON.parse(await readFile(join(project, '.mcp.json'), 'utf8'));
  assert.equal(config.mcpServers.other.command, 'keep-me');
  assert.equal(Object.keys(config.mcpServers).length, 2);
  assert.ok(!(await readdir(project)).includes('.teammates-connect.lock'));
});
