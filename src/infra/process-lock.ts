import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function acquireProcessLock(directory: string): () => void {
  const path = join(directory, 'run.lock');
  if (existsSync(path)) {
    let pid: number;
    try {
      pid = Number(JSON.parse(readFileSync(path, 'utf8')).pid);
    } catch {
      throw new Error('Process lock is unreadable; inspect it before starting another instance');
    }
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error('Process lock contains an invalid PID');
    let active = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') active = false;
    }
    if (active) throw new Error(`Another bot instance may be running with PID ${pid}`);
    unlinkSync(path);
  }
  writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), {
    flag: 'wx',
    mode: 0o600,
  });
  return () => {
    if (existsSync(path)) {
      const value = JSON.parse(readFileSync(path, 'utf8')) as { pid: number };
      if (value.pid === process.pid) unlinkSync(path);
    }
  };
}
