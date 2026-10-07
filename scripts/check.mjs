import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
async function walk(dir) {
  const out = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.name.startsWith('.') || item.name === 'node_modules') continue;
    const path = join(dir, item.name);
    if (item.isDirectory()) out.push(...await walk(path));
    else out.push(path);
  }
  return out;
}
const files = await walk(root);
for (const file of files.filter(path => path.endsWith('.mjs'))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(1); }
}
const role = JSON.parse(await readFile(join(root, 'roles/chief-of-events/role.json'), 'utf8'));
if (role.id !== 'chief-of-events' || !role.mission || !role.traits?.length || !role.standards?.length) throw new Error('Role metadata is incomplete.');
const skill = await readFile(join(root, 'skills/chief-of-events/SKILL.md'), 'utf8');
if (!skill.startsWith('---\n') || !skill.includes('description:')) throw new Error('Portable skill frontmatter is missing.');
console.log(`Checked JavaScript syntax and role pack (${files.length} files).`);
