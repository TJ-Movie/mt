import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { S3Client, ListObjectsV2Command, HeadObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
const exec = promisify(execFile);
const q = (v) => `'${String(v).replaceAll("'", "''")}'`;
async function sql(command) {
  const { stdout } = await exec(process.execPath, ['node_modules/wrangler/bin/wrangler.js','d1','execute','flixlyra-db','--remote','--config','wrangler.json','--json','--command',command], { maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return JSON.parse(stdout).flatMap((x) => x.results || []);
}
const s3 = new S3Client({ region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
const bucket = process.env.R2_BUCKET_NAME;
const head = async (key) => { try { const x = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return x.ContentType === 'video/mp4' && (x.ContentLength || 0) > 0 ? x : null; } catch { return null; } };
const rows = await sql("SELECT id,title,imdb_id,r2_storage_key,download_sources_json FROM movies WHERE publication_status='draft' AND imdb_id IS NOT NULL ORDER BY id LIMIT 20");
const mapped = [];
for (const row of rows) {
  const parsed = JSON.parse(row.download_sources_json || '{}'); const sources = Array.isArray(parsed) ? parsed : (parsed.sources || []);
  const legacy = /^assets\/[0-9a-f-]+\/data\.bin$/.test(row.r2_storage_key || '') ? await head(row.r2_storage_key) : null;
  const next = sources.map((source) => String(source.quality).toLowerCase() === '1080p' && !source.r2StorageKey && legacy ? { ...source, r2StorageKey: row.r2_storage_key, r2Bytes: legacy.ContentLength } : source);
  if (JSON.stringify(next) !== JSON.stringify(sources)) await sql(`UPDATE movies SET download_sources_json=${q(JSON.stringify({ status: parsed.status || 'pending', sources: next }))}, revision=revision+1, updated_at=${q(new Date().toISOString())} WHERE id=${Number(row.id)} AND publication_status='draft'`);
  const checks = await Promise.all(next.filter((source) => /^(720p|1080p)$/.test(String(source.quality).toLowerCase()) && source.r2StorageKey).map(async (source) => ({ quality: String(source.quality).toLowerCase(), ok: Boolean(await head(source.r2StorageKey)) })));
  if (checks.every((x) => x.ok) && checks.some((x) => x.quality === '720p') && checks.some((x) => x.quality === '1080p')) mapped.push({ id: row.id, title: row.title, imdbId: row.imdb_id });
}
let token; const objects = [];
do { const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token })); objects.push(...(page.Contents || [])); token = page.IsTruncated ? page.NextContinuationToken : undefined; } while (token);
const duplicates = objects.filter((o) => /\/1080p\.mp4$/.test(o.Key || ''));
const referenced = new Set((await sql("SELECT download_sources_json FROM movies WHERE publication_status='draft'")).flatMap((row) => { try { const p = JSON.parse(row.download_sources_json || '{}'); const s = Array.isArray(p) ? p : p.sources || []; return s.map((x) => x.r2StorageKey).filter(Boolean); } catch { return []; } }));
const deletable = duplicates.filter((o) => !referenced.has(o.Key));
if (deletable.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: deletable.map((o) => ({ Key: o.Key })), Quiet: true } }));
console.log(JSON.stringify({ mappedLegacy1080: rows.length, deletedDuplicate1080: deletable.length, completeTitles: mapped }, null, 2));
s3.destroy();
