import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const before = '      if (this.pieces[index]) return\n      this.store.get(index, { offset, length }, cb)';
const after = `      // Flixlyra: a peer can request data before store setup or after teardown.
      if (this.destroyed || !this.ready || !this.store) return wire.destroy()
      if (this.pieces[index]) return
      this.store.get(index, { offset, length }, cb)`;
const iteratorPendingBefore = `    this.destroyed = false\n`;
const iteratorPendingAfter = `    this.destroyed = false\n    this._pendingResolve = null\n`;
const iteratorPromiseBefore = `    return new Promise((resolve, reject) => {`;
const iteratorPromiseAfter = `    return new Promise((resolve, reject) => {\n      this._pendingResolve = resolve`;
const iteratorDestroyBefore = `    this.destroyed = true\n    if (!this._torrent.destroyed) {`;
const iteratorDestroyAfter = `    this.destroyed = true\n    if (this._pendingResolve) {\n      const resolve = this._pendingResolve\n      this._pendingResolve = null\n      resolve({ done: true })\n    }\n    if (!this._torrent.destroyed) {`;
export function guardedSource(source) {
  if (source.includes(after)) return source;
  if (source.split(before).length !== 2) throw new Error('WebTorrent request handler changed; review compatibility guard before transfer');
  return source.replace(before, after);
}
export function guardedFileIteratorSource(source) {
  if (source.includes(iteratorDestroyAfter)) return source;
  for (const marker of [iteratorPendingBefore, iteratorPromiseBefore, iteratorDestroyBefore]) {
    if (!source.includes(marker)) throw new Error('WebTorrent file iterator changed; review cleanup guard before transfer');
  }
  let patched = source.replace(iteratorPendingBefore, iteratorPendingAfter);
  patched = patched.replace(iteratorPromiseBefore, iteratorPromiseAfter);
  patched = patched.replace(iteratorDestroyBefore, iteratorDestroyAfter);
  patched = patched.replace(
    `      if (this._missing === 0 || this.destroyed) {\n        resolve({ done: true })`,
    `      if (this._missing === 0 || this.destroyed) {\n        this._pendingResolve = null\n        resolve({ done: true })`,
  );
  patched = patched.replace(
    `              } else {\n                resolve({ done: true })`,
    `              } else {\n                this._pendingResolve = null\n                resolve({ done: true })`,
  );
  patched = patched.replace(
    `          if (this.destroyed) return resolve({ done: true }) // prevent hanging`,
    `          if (this.destroyed) { this._pendingResolve = null; return resolve({ done: true }) } // prevent hanging`,
  );
  patched = patched.replace(
    `        if (this.destroyed) return resolve({ done: true })`,
    `        if (this.destroyed) { this._pendingResolve = null; return resolve({ done: true }) }`,
  );
  patched = patched.replace(
    `            return resolve({ done: true })\n          }\n\n          // prevent re-wrapping outside of promise`,
    `            this._pendingResolve = null\n            return resolve({ done: true })\n          }\n\n          // prevent re-wrapping outside of promise`,
  );
  patched = patched.replace(
    `          resolve({ value: buffer, done: false })`,
    `          this._pendingResolve = null\n          resolve({ value: buffer, done: false })`,
  );
  return patched;
}
export async function patchWebTorrent() {
  const packageInfo = JSON.parse(await readFile('node_modules/webtorrent/package.json', 'utf8'));
  if (packageInfo.version !== '3.0.21') throw new Error('Review WebTorrent compatibility guard for new version');
  const torrentPath = 'node_modules/webtorrent/lib/torrent.js';
  const torrentSource = await readFile(torrentPath, 'utf8');
  const patchedTorrent = guardedSource(torrentSource);
  if (patchedTorrent !== torrentSource) await writeFile(torrentPath, patchedTorrent);
  const iteratorPath = 'node_modules/webtorrent/lib/file-iterator.js';
  const iteratorSource = await readFile(iteratorPath, 'utf8');
  const patchedIterator = guardedFileIteratorSource(iteratorSource);
  if (patchedIterator !== iteratorSource) await writeFile(iteratorPath, patchedIterator);
}
// Every entry point must verify the guard before Node caches the torrent module.
export async function loadGuardedWebTorrent() {
  await patchWebTorrent();
  return (await import('webtorrent')).default;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await patchWebTorrent();
  console.log('WebTorrent peer request lifecycle guard verified');
}
