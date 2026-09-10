import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile('app/api/admin/ingest/yts/route.ts', 'utf8');
const ids = [...source.matchAll(/'(tt\d{7,10})'/g)].map(match => match[1]);
const endpoint = source.match(/const YTS_ENDPOINT = '([^']+)'/)[1];
for (const id of ids) {
  const response = await fetch(`${endpoint}?imdb_id=${id}`, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, id);
  const { data } = await response.json();
  assert.equal(data.movie.imdb_code, id);
  const preferred = data.movie.torrents.find(t => t.quality === '1080p') ?? data.movie.torrents.find(t => t.quality === '720p');
  assert.ok(preferred, `${id}: no preferred torrent`);
  console.log(`${id}: metadata OK, ${preferred.quality}`);
}
console.log(`${ids.length} source records verified; no database or R2 writes performed.`);
