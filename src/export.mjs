import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const packageRoot = new URL('../', import.meta.url);
export const supportedRuntimes = Object.freeze([
  'generic', 'hermes', 'openclaw', 'pi', 'open-dots', 'open-instinct',
]);

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function statIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertDirectory(path) {
  const stat = await statIfPresent(path);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error(`Export directory must be a real directory: ${path}`);
  }
}

async function readBundle() {
  const [foundation, soul, agents, roleText, skill] = await Promise.all([
    readFile(new URL('dna/FOUNDATION.md', packageRoot), 'utf8'),
    readFile(new URL('roles/chief-of-events/SOUL.md', packageRoot), 'utf8'),
    readFile(new URL('roles/chief-of-events/AGENTS.md', packageRoot), 'utf8'),
    readFile(new URL('roles/chief-of-events/role.json', packageRoot), 'utf8'),
    readFile(new URL('skills/chief-of-events/SKILL.md', packageRoot), 'utf8'),
  ]);
  return { foundation, soul, agents, role: JSON.parse(roleText), skill };
}

function adapt(runtime, out, bundle) {
  const { foundation, soul, agents, role, skill } = bundle;
  const name = role.name || role.identity?.name || 'Mira';
  const title = role.title || 'Chief of Events';
  const persona = `${foundation.trim()}\n\n${soul.trim()}\n`;
  const prompt = `${persona}\n${agents.trim()}\n\n${skill.trim()}\n`;
  const files = new Map([
    ['SOUL.md', persona],
    ['AGENTS.md', `${agents.trim()}\n`],
    ['IDENTITY.md', `# Identity\n\n- Name: ${name}\n- Role: ${title}\n- Series: Open Teammates\n- Status: AI teammate; independent open-source project\n`],
    ['role.json', `${JSON.stringify(role, null, 2)}\n`],
    ['skills/chief-of-events/SKILL.md', skill],
  ]);
  const limits = [
    'Exports contain personality and operating instructions. They do not bind tools, create calendars, connect accounts, schedule work, or grant authority.',
    'The receiving runtime controls models, credentials, memory, sandboxing, tool permissions, and external execution. Prompt rules are advisory; Open Teammates policy checks do not travel as runtime enforcement.',
    'These formats were checked against primary source documentation on 2026-10-07. A live end-to-end runtime installation has not been tested here.',
  ];
  const quotedOut = shellQuote(out);
  let instructions;

  switch (runtime) {
    case 'hermes': {
      files.set('distribution.yaml', [
        'name: chief-of-events',
        `version: ${JSON.stringify(String(role.version || '0.1.0'))}`,
        'description: "Mira, Chief of Events — an independent Open Teammates role"',
        'license: MIT',
        'env_requires: []',
        'distribution_owned:',
        '  - SOUL.md',
        '  - AGENTS.md',
        '  - IDENTITY.md',
        '  - role.json',
        '  - skills/chief-of-events/',
        '  - distribution.yaml',
        '  - config.yaml',
        '',
      ].join('\n'));
      files.set('config.yaml', '# Select your own model and provider with Hermes setup.\nterminal:\n  cwd: "."\n');
      instructions = [
        'Install Hermes separately using its official installation guide: https://hermes-agent.nousresearch.com/docs/getting-started/installation',
        `hermes profile install ${quotedOut} --name chief-of-events --alias`,
        'hermes -p chief-of-events setup',
        `cd ${quotedOut}`,
        'hermes -p chief-of-events chat',
        'Launch from this export directory so Hermes discovers AGENTS.md. The installed profile supplies SOUL.md and skills; its model/provider remain your configuration.',
      ];
      limits.push('No cron jobs, MCP servers, credentials, or bundled host integrations are included. This is a Hermes profile distribution, not an installer for Hermes itself.');
      break;
    }
    case 'openclaw':
      instructions = [
        'Install and configure OpenClaw separately: https://docs.openclaw.ai/start/getting-started',
        `openclaw agents add chief-of-events --workspace ${quotedOut}`,
        'Use a different new agent ID if chief-of-events already exists. Review the created agent in OpenClaw before binding a channel or enabling tools.',
        'OpenClaw reads the workspace SOUL.md, AGENTS.md, IDENTITY.md and skills. Configure the model, access, memory and routing through OpenClaw.',
      ];
      limits.push('Uses the documented workspace interface. Experimental CLAW.md packaging is deliberately not required; no gateway or channel binding is created by this export.');
      break;
    case 'pi':
      files.set('system-prompt.md', prompt);
      instructions = [
        'Install Pi separately following https://github.com/earendil-works/pi; the current npm package is @earendil-works/pi-coding-agent.',
        `pi --append-system-prompt ${shellQuote(join(out, 'system-prompt.md'))} --skill ${shellQuote(join(out, 'skills/chief-of-events'))}`,
        'Choose and authenticate a model through Pi. The explicit prompt and skill paths load the role for this invocation without changing global Pi settings.',
      ];
      limits.push('Pi runs tools with the launching process permissions unless the operator supplies isolation. This export adds instructions and a skill, not a permission extension or a persistent worker.');
      break;
    case 'open-dots':
      files.set('bot.json', `${JSON.stringify({
        name,
        role: title,
        description: 'An independent Open Teammates Chief of Events persona.',
        avatar: '🎟️',
        accent_color: '#0d9488',
        system_prompt: prompt,
        tools: [],
      }, null, 2)}\n`);
      instructions = [
        'Manual persona import only. Install and start Open Dots separately: https://github.com/Anil-matcha/open-dots.',
        'Review bot.json. Its fields match the authenticated POST /api/v1/bots request body at the inspected upstream revision; use your existing owner authentication to submit it, or enter the persona in its UI.',
        'The model field is intentionally omitted so the host selects its configured default. Enable only tools you have configured and approved in Open Dots.',
      ];
      limits.push('Open Dots identifies itself as an early prototype. bot.json is a reviewed import payload, not a direct installer, an authenticated connector, or evidence of live compatibility.');
      break;
    case 'open-instinct':
      files.set('PERSONA.md', persona);
      instructions = [
        'Manual adaptation only, targeting Maria Gorskikh’s Open Instinct: https://github.com/mariagorskikh/open-instinct.',
        'Initialize that runtime separately. Review and merge PERSONA.md and AGENTS.md into its INSTINCT_DATA_DIR (default ./.instinct); preserve your existing identity and policies.',
        'Add skills/chief-of-events alongside that runtime’s existing skills, or merge all desired skills into a separate directory and point INSTINCT_SKILLS_DIR there. The upstream runtime loads one skills directory.',
        'Merit Systems OpenInstinct is a separate implementation. It has no verified drop-in persona importer; adapting its agent instruction files requires a separate code review that preserves its transport, vault, and execution rules.',
      ];
      limits.push('No Inkbox, Maritime, Composio, Vercel, Kernel, Linq, Google Workspace or payment integration is installed or connected. The two projects named Open Instinct are not interchangeable.');
      break;
    default:
      instructions = [
        'Review SOUL.md (shared DNA plus persona), AGENTS.md (role operations), role.json and skills/chief-of-events/SKILL.md.',
        'Load SOUL.md and AGENTS.md as trusted operating instructions in your chosen host, and install the skill only where that host supports the Agent Skills format.',
        'Configure models, tool permissions and account connections in your host separately. This generic bundle is a manual import format.',
      ];
  }

  files.set('INTEGRATION.md', [
    `# Chief of Events — ${runtime} export`,
    '',
    'Open Teammates is an independent project and is not affiliated with OpenAI, Nous Research, OpenClaw, or either Open Instinct project.',
    '',
    '## Use this bundle',
    '',
    ...instructions.map((instruction) => `- ${instruction}`),
    '',
    '## Integration scope',
    '',
    ...limits.map((limit) => `- ${limit}`),
    '',
  ].join('\n'));
  return { files, instructions, limits };
}

/** Export trusted instructions to a fresh directory; never modifies host config. */
export async function exportRuntime({ runtime = 'generic', out, force = false } = {}) {
  if (!supportedRuntimes.includes(runtime)) {
    throw new Error(`Unsupported runtime: ${runtime}. Choose ${supportedRuntimes.join(', ')}.`);
  }
  if (typeof out !== 'string' || !out.trim()) {
    throw new Error('Provide an output directory with --out.');
  }
  const destination = resolve(out);
  const present = await statIfPresent(destination);
  if (present && (!present.isDirectory() || present.isSymbolicLink())) {
    throw new Error(`Export destination must be a real directory: ${destination}`);
  }
  if (present && !force) {
    const error = new Error(`Export destination already exists: ${destination}. Choose a new directory or use --force.`);
    error.code = 'EEXIST';
    throw error;
  }
  // Read every bundled source before creating any output, so missing package data
  // cannot leave a misleading half-export behind.
  const adapted = adapt(runtime, destination, await readBundle());
  const directories = new Set([destination]);
  for (const filename of adapted.files.keys()) {
    let directory = dirname(join(destination, filename));
    while (directory !== destination) {
      directories.add(directory);
      const parent = dirname(directory);
      if (parent === directory) throw new Error('Export path escaped its destination.');
      directory = parent;
    }
    const existing = await statIfPresent(join(destination, filename));
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink > 1)) {
      throw new Error(`Refusing to replace a non-regular or linked export file: ${filename}`);
    }
  }
  for (const directory of directories) await assertDirectory(directory);
  await mkdir(destination, { recursive: true });
  for (const [filename, content] of adapted.files) {
    const path = join(destination, filename);
    await mkdir(dirname(path), { recursive: true });
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW
      | (force ? constants.O_TRUNC : constants.O_EXCL);
    const handle = await open(path, flags, 0o644);
    try {
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close();
    }
  }
  return {
    runtime,
    out: destination,
    files: [...adapted.files.keys()],
    instructions: adapted.instructions,
    limits: adapted.limits,
  };
}
