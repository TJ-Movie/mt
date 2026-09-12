import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const q = (v) => `'${String(v).replaceAll("'", "''")}'`;
async function sql(command) {
  const { stdout } = await exec(process.execPath, ['node_modules/wrangler/bin/wrangler.js','d1','execute','flixlyra-db','--remote','--config','wrangler.json','--json','--command',command], { maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return JSON.parse(stdout).flatMap((x) => x.results || []);
}
const before = await sql("SELECT id,title,publication_status,rights_status,official_watch_url,ingest_status,r2_storage_key,r2_video_bytes,download_sources_json FROM movies WHERE id=12");
await sql(`UPDATE movies SET official_watch_url=${q('https://www.youtube.com/watch?v=5PSNL1qE6VY')}, revision=revision+1, updated_at=${q(new Date().toISOString())} WHERE id=12 AND imdb_id='tt0499549'`);
const after = await sql("SELECT id,title,publication_status,rights_status,official_watch_url,ingest_status,r2_storage_key,r2_video_bytes,download_sources_json FROM movies WHERE id=12");
console.log(JSON.stringify({ before, after }, null, 2));
