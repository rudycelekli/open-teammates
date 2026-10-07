import { open, readFile, unlink, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function recoverDeadOwner(path) {
  // Serialize recovery separately. A second reaper must re-read the main lock
  // after acquiring this guard, never unlink an inode it observed earlier.
  const recoveryPath = `${path}.recovery`;
  let guard;
  try { guard = await open(recoveryPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return; throw error; }
  try {
    await guard.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    const stat = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) return;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Workspace lock must be a regular file.');
    let owner;
    try { owner = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return; throw error; }
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string') return;
    try { process.kill(owner.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  } finally { await guard.close(); await unlink(recoveryPath).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
/** Cooperative single-host lock; recover only an observed dead process. */
export async function acquireWorkspaceLock(path, { timeoutMs = 5000 } = {}) {
  const token = randomUUID();
  const started = Date.now();
  while (true) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })); }
      catch (error) { await handle.close(); await unlink(path).catch(() => {}); throw error; }
      await handle.close();
      return async () => {
        try { const owner = JSON.parse(await readFile(path, 'utf8')); if (owner.token === token) await unlink(path); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await lstat(path).catch(() => null);
      if (!stat) continue;
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Workspace lock must be a regular file.');
      await recoverDeadOwner(path);
      if (Date.now() - started > timeoutMs) throw new Error('Workspace is busy or has an invalid lock. Retry after the active operation finishes.');
      await delay(20 + Math.floor(Math.random() * 20));
    }
  }
}
