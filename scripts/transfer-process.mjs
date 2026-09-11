import { spawn } from 'node:child_process';

/** Only terminate the child we own; never continue inside a crashed torrent runtime. */
export function runChild(args, { env = process.env, timeoutMs, graceMs = 15000, onSpawn = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: 'inherit', windowsHide: true });
    let force, timedOut = false;
    const stop = () => {
      timedOut = true;
      child.kill('SIGTERM');
      force ??= setTimeout(() => child.kill('SIGKILL'), graceMs);
    };
    const timer = setTimeout(stop, timeoutMs);
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    const cleanup = () => { clearTimeout(timer); clearTimeout(force); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, signal) => { cleanup(); resolve({ code, signal, timedOut }); });
    onSpawn(child);
  });
}
