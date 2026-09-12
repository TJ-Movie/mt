import { readFile, realpath, stat, open } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyPlan(plan, root = 'tmp/media') {
  if (plan?.schema !== 'flixlyra-cloud-v1' || !Array.isArray(plan.files)) throw new Error('Invalid cloud manifest');
  const base = await realpath(root);
  const identities = new Set();
  const keys = new Set();
  let staged = 0;
  for (const item of plan.files) {
    const identity = `${item.id}:${item.quality}`;
    if (!Number.isSafeInteger(item.id) || item.id < 1 || !['720p','1080p'].includes(item.quality) ||
      !/^assets\/[a-f0-9-]{36}\/(?:data\.bin|720p\.mp4|1080p\.mp4)$/.test(item.key) ||
      identities.has(identity) || keys.has(item.key) || typeof item.verified !== 'boolean' ||
      (item.skipped !== undefined && typeof item.skipped !== 'boolean')) throw new Error('Invalid or duplicate media binding');
    identities.add(identity); keys.add(item.key);
    if (item.verified && (!Number.isSafeInteger(item.bytes) || item.bytes <= 0)) throw new Error('Invalid verified size');
    if (item.file) {
      const file = await realpath(item.file);
      if (!file.startsWith(base + sep)) throw new Error('Media escapes staging directory');
      const info = await stat(file);
      if (!info.isFile() || info.size <= 0 || info.size !== item.bytes) throw new Error('Staged size mismatch');
      const handle = await open(file, 'r'); const header = Buffer.alloc(12);
      try { await handle.read(header, 0, 12, 0); } finally { await handle.close(); }
      if (header.subarray(4,8).toString() !== 'ftyp') throw new Error('Invalid staged MP4');
      staged++;
    }
  }
  if (plan.files.some(f => !f.verified && !f.skipped) && staged === 0) throw new Error('Pending assets require a staged video');
  return { total: plan.files.length, staged, verified: plan.files.filter(f => f.verified).length, skipped: plan.files.filter(f => f.skipped).length };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(await verifyPlan(JSON.parse(await readFile('tmp/r2-video-manifest.json', 'utf8'))));
}
