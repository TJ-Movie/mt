import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const before = '      if (this.pieces[index]) return\n      this.store.get(index, { offset, length }, cb)';
const after = `      // Flixlyra: a peer can request data before store setup or after teardown.
      if (this.destroyed || !this.ready || !this.store) return wire.destroy()
      if (this.pieces[index]) return
      this.store.get(index, { offset, length }, cb)`;
export function guardedSource(source) {
  if (source.includes(after)) return source;
  if (source.split(before).length !== 2) throw new Error('WebTorrent request handler changed; review compatibility guard before transfer');
  return source.replace(before, after);
}
export async function patchWebTorrent() {
  const packageInfo = JSON.parse(await readFile('node_modules/webtorrent/package.json', 'utf8'));
  if (packageInfo.version !== '3.0.21') throw new Error('Review WebTorrent compatibility guard for new version');
  const path = 'node_modules/webtorrent/lib/torrent.js';
  const source = await readFile(path, 'utf8');
  const patched = guardedSource(source);
  if (patched !== source) await writeFile(path, patched);
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
