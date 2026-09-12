import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, statfs, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { loadGuardedWebTorrent } from './webtorrent-guard.mjs';
import { S3Client, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { runChild } from './transfer-process.mjs';

const exec = promisify(execFile);
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
// WebTorrent returns a streamx stream, which AWS Upload does not recognize as
// a native Node Readable. Adapt its async iterator without buffering the film.
export function uploadStream(source) {
  return Readable.from(source, { objectMode: false, highWaterMark: 256 * 1024 });
}
export function transferLimits(environment = process.env) {
  const number = (name, fallback, min, max) => {
    const value = Number(environment[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  };
  return {
    batch: number('TRANSFER_BATCH_SIZE', 20, 1, 20),
    timeout: number('TRANSFER_TIMEOUT_SECONDS', 10800, 60, 10800),
    run: number('TRANSFER_RUN_SECONDS', 86400, 60, 86400),
    maxBytes: number('TRANSFER_MAX_BYTES', 21474836480, 1, 21474836480),
    reserve: number('TRANSFER_DISK_RESERVE_BYTES', 2147483648, 104857600, 21474836480),
    download: number('TRANSFER_DOWNLOAD_BPS', 8388608, 65536, 104857600),
    upload: number('TRANSFER_UPLOAD_BPS', 524288, 16384, 10485760),
  };
}
export function hasDiskBudget(totalBytes, freeBytes, limits) {
  return Number.isSafeInteger(totalBytes) && totalBytes > 0 &&
    totalBytes <= limits.maxBytes && totalBytes + limits.reserve <= freeBytes;
}
export function primaryMp4(files) {
  return files.filter(f => /\.mp4$/i.test(f.name) && !/(^|[\s._-])(sample|trailer)([\s._-]|$)/i.test(f.name))
    .sort((a, b) => b.length - a.length)[0];
}
export function sourceMagnet(json, quality) {
  let parsed;
  try { parsed = JSON.parse(json); } catch { return null; }
  const sources = Array.isArray(parsed) ? parsed : parsed?.sources;
  const source = sources?.find(s => (!quality || String(s.quality).toLowerCase() === quality) && /^magnet:\?/i.test(s.url));
  if (!source) return null;
  const xt = new URL(source.url).searchParams.get('xt');
  // Drop arbitrary web seeds and other URL parameters supplied by the source.
  return /^urn:btih:(?:[0-9a-f]{40}|[a-z2-7]{32})$/i.test(xt || '') ? `magnet:?xt=${xt}` : null;
}

async function sql(command) {
  let stdout;
  try {
    ({ stdout } = await exec(process.execPath, ['node_modules/wrangler/bin/wrangler.js',
    'd1', 'execute', 'flixlyra-db', '--remote', '--config', 'wrangler.json', '--json', '--command', command],
    { maxBuffer: 4 * 1024 * 1024, windowsHide: true, timeout: 60000 }));
  } catch (error) {
    let diagnostic = String(error.stdout || error.stderr || 'D1 command failed without a diagnostic');
    for (const name of ['CLOUDFLARE_API_TOKEN', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
      if (process.env[name]) diagnostic = diagnostic.replaceAll(process.env[name], '[redacted]');
    }
    throw new Error(`D1 access failed: ${diagnostic.slice(-2000)}`);
  }
  const response = JSON.parse(stdout);
  if (response.some(r => r.success === false)) throw new Error('D1 query failed');
  return response.flatMap(r => r.results || []);
}

async function remoteDescriptor(json, quality) {
  const parsed = JSON.parse(json);
  const sources = Array.isArray(parsed) ? parsed : parsed.sources;
  const allowed = new Set((process.env.TORRENT_SOURCE_HOSTS || 'yts.gg').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  const candidate = sources?.find(s => (!quality || String(s.quality).toLowerCase() === quality) && s.url && !s.descriptorKey && (() => {
    try {
      const url = new URL(s.url);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port && allowed.has(url.hostname);
    } catch { return false; }
  })());
  if (!candidate) throw new Error('No magnet, stored descriptor, or allowlisted HTTPS torrent source');
  const response = await fetch(candidate.url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.body) throw new Error('Torrent descriptor fetch failed');
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > 2 * 1024 * 1024) throw new Error('Torrent descriptor exceeds 2 MiB');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function transfer(row, s3, bucket, limits, requestedQuality) {
  const token = process.env.TRANSFER_CHILD_TOKEN || randomUUID();
  const quality = /^(720p|1080p)$/.test(requestedQuality || '') ? requestedQuality : null;
  const now = Math.floor(Date.now() / 1000);
  const claimed = await sql(`UPDATE movies SET ingest_status='transferring', transfer_token=${quote(token)},
    transfer_lease_until=${now + limits.timeout + 600}, transfer_error=NULL WHERE id=${Number(row.id)} AND
    (ingest_status IN ('queued','processing') OR (ingest_status='transferring' AND transfer_lease_until < ${now})) RETURNING id`);
  if (!claimed.length) return;
  let folder, client, upload, stream, timer;
  let committed = false;
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Transfer interrupted'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    folder = process.env.TRANSFER_CHILD_DIRECTORY || await mkdtemp(join(tmpdir(), 'flixlyra-transfer-'));
    if (dirname(resolve(folder)) !== resolve(tmpdir()) || !basename(folder).startsWith('flixlyra-transfer-')) throw new Error('Invalid transfer scratch directory');
    const WebTorrent = await loadGuardedWebTorrent();
    client = new WebTorrent({ webSeeds: false, maxConns: 30,
      downloadLimit: limits.download, uploadLimit: limits.upload });
    const parsed = JSON.parse(row.download_sources_json || '{}');
    const sources = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.sources) ? parsed.sources : []);
    const selected = quality ? sources.find(s => String(s.quality).toLowerCase() === quality) : sources.find(s => /^(1080p|720p)$/.test(String(s.quality).toLowerCase()));
    const effectiveQuality = quality || (selected && /^(720p|1080p)$/.test(String(selected.quality).toLowerCase()) ? String(selected.quality).toLowerCase() : null);
    const key = `assets/${randomUUID()}/${effectiveQuality || 'video'}.mp4`;
    let source = sourceMagnet(row.download_sources_json, effectiveQuality);
    const descriptorKey = selected?.descriptorKey || (!effectiveQuality ? row.storage_key : null);
    if (!source && descriptorKey && /^(?:assets|descriptors)\/[\w.-]+\.(?:torrent|bin)$/.test(descriptorKey)) {
      const descriptor = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: descriptorKey }), { abortSignal: AbortSignal.timeout(30000) });
      if (!descriptor.ContentLength || descriptor.ContentLength > 2 * 1024 * 1024) {
        descriptor.Body?.destroy();
        throw new Error('Invalid torrent descriptor size');
      }
      source = Buffer.from(await descriptor.Body.transformToByteArray());
    }
    if (!source) source = await remoteDescriptor(row.download_sources_json, effectiveQuality);
    const run = async () => {
      const torrent = await new Promise((resolve, reject) => {
        client.once('error', reject);
        const pending = client.add(source, { path: folder, deselect: true, strategy: 'sequential', storeCacheSlots: 2 }, resolve);
        pending.once('error', reject);
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      });
      const file = primaryMp4(torrent.files);
      if (!file) throw new Error('No MP4 video found; remux/transcode to MP4 before queueing');
      if (torrent.pieceLength > 16 * 1024 * 1024) throw new Error('Torrent piece size exceeds memory safety limit');
      const disk = await statfs(folder);
      if (!hasDiskBudget(torrent.length, disk.bavail * disk.bsize, limits)) throw new Error('Torrent exceeds size limit or available disk budget');
      torrent.deselect(0, torrent.pieces.length - 1, false);
      file.select();
      stream = uploadStream(file.createReadStream());
      // Verify the container instead of relabeling arbitrary files as MP4.
      const header = await new Promise((resolve, reject) => {
        const probe = file.createReadStream({ start: 0, end: 11 });
        const chunks = [];
        probe.on('data', chunk => chunks.push(chunk));
        probe.once('error', reject);
        probe.once('end', () => resolve(Buffer.concat(chunks)));
      });
      if (header.subarray(4, 8).toString() !== 'ftyp') throw new Error('Source is not an MP4 container');
      upload = new Upload({ client: s3, queueSize: 2, partSize: 8 * 1024 * 1024, leavePartsOnError: false,
        params: { Bucket: bucket, Key: key, Body: stream, ContentLength: file.length,
          ContentType: 'video/mp4', CacheControl: 'private, no-store' } });
      await upload.done();
      controller.signal.throwIfAborted();
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      controller.signal.throwIfAborted();
      if (head.ContentLength !== file.length || head.ContentType !== 'video/mp4') throw new Error('Uploaded video verification failed');
      const nextSources = sources.map(s => (effectiveQuality && String(s.quality).toLowerCase() === effectiveQuality) ? { ...s, r2StorageKey: key, r2Bytes: file.length } : s);
      const qualitySources = nextSources.filter(s => /^(720p|1080p)$/.test(String(s.quality).toLowerCase()));
      const allReady = ['720p', '1080p'].every(required => qualitySources.some(s => String(s.quality).toLowerCase() === required && typeof s.r2StorageKey === 'string' && Number.isSafeInteger(s.r2Bytes) && s.r2Bytes > 0));
      const updated = await sql(`UPDATE movies SET ingest_status=${allReady ? "'ready'" : "'processing'"}, r2_storage_key=${quote(key)},
        r2_video_bytes=${file.length}, download_sources_json=${quote(JSON.stringify({ status: allReady ? 'available' : 'pending', sources: nextSources }))}, transfer_token=NULL, transfer_lease_until=NULL, transfer_error=NULL
        WHERE id=${Number(row.id)} AND transfer_token=${quote(token)} AND ingest_status='transferring' RETURNING id`);
      if (!updated.length) throw new Error('Transfer lease lost');
      committed = true;
      console.log(`Ready: ${row.id} (${file.length} bytes)`);
    };
    await Promise.race([run(), new Promise((_, reject) => {
      timer = setTimeout(() => controller.abort(new Error('Transfer deadline exceeded')), limits.timeout * 1000);
      controller.signal.addEventListener('abort', () => { stream?.destroy(); void upload?.abort(); reject(controller.signal.reason); }, { once: true });
    })]);
  } catch (error) {
    await upload?.abort().catch(() => {});
    const message = String(error.message || 'Transfer failed').slice(0, 250);
    const failed = await sql(`UPDATE movies SET ingest_status='failed', transfer_error=${quote(message)}, transfer_token=NULL,
      transfer_lease_until=NULL WHERE id=${Number(row.id)} AND transfer_token=${quote(token)} AND ingest_status='transferring' RETURNING id`);
    // Never delete a possibly committed object after an ambiguous D1 response.
    if (!committed && failed.length) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => {});
    console.error(`Failed: ${row.id}: ${message}`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    stream?.destroy();
    if (client) await new Promise(resolve => {
      const timer = setTimeout(resolve, 10000);
      client.destroy(() => { clearTimeout(timer); resolve(); });
    });
    // Only the unique temporary directory created by this transfer is removed.
    if (folder && dirname(resolve(folder)) === resolve(tmpdir()) && basename(folder).startsWith('flixlyra-transfer-')) {
      await rm(folder, { recursive: true, force: true });
    }
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

export async function main() {
  const limits = transferLimits();
  const requestedQuality = /^(720p|1080p)$/.test(process.env.TRANSFER_QUALITY || '') ? process.env.TRANSFER_QUALITY : null;
  const deadline = Date.now() + limits.run * 1000;
  let interrupted = false;
  const markInterrupted = () => { interrupted = true; process.exitCode = 1; };
  process.once('SIGTERM', markInterrupted);
  process.once('SIGINT', markInterrupted);
  if (process.env.GITHUB_ACTIONS === 'true' && !process.env.CLOUDFLARE_API_TOKEN) throw new Error('Missing CLOUDFLARE_API_TOKEN for D1');
  if (process.env.GITHUB_ACTIONS === 'true' && process.argv.includes('--watch')) throw new Error('--watch is not supported on GitHub Actions');
  for (const name of ['R2_ACCOUNT_ID', 'R2_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
    if (!process.env[name]) throw new Error(`Missing ${name}; see MAGNET-TO-R2.md`);
  }
  const config = JSON.parse(await readFile('wrangler.json', 'utf8'));
  if (config.account_id !== process.env.R2_ACCOUNT_ID ||
      (process.env.CLOUDFLARE_ACCOUNT_ID && config.account_id !== process.env.CLOUDFLARE_ACCOUNT_ID) ||
      !config.r2_buckets?.some(bucket => bucket.binding === 'MEDIA' && bucket.bucket_name === process.env.R2_BUCKET_NAME)) {
    throw new Error('R2 account/bucket secrets do not match the D1 application configuration');
  }
  const s3 = new S3Client({ region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
  try {
    const childId = process.argv.find(arg => arg.startsWith('--transfer-id='))?.slice(14);
    const childQuality = process.argv.find(arg => arg.startsWith('--quality='))?.slice(10);
    if (childId !== undefined) {
      if (!/^[1-9]\d{0,9}$/.test(childId) || !/^[a-f0-9-]{36}$/.test(process.env.TRANSFER_CHILD_TOKEN || '')) throw new Error('Invalid child transfer identity');
      const rows = await sql(`SELECT id, storage_key, download_sources_json FROM movies WHERE id=${Number(childId)}`);
      if (rows.length) await transfer(rows[0], s3, process.env.R2_BUCKET_NAME, limits, childQuality);
      return;
    }
    do {
      const rows = await sql(`SELECT id, storage_key, download_sources_json FROM movies WHERE
        (ingest_status IN ('queued','processing') OR (ingest_status='transferring' AND transfer_lease_until < unixepoch()))
        ORDER BY id LIMIT ${limits.batch}`);
      for (const row of rows) {
        if (interrupted || Date.now() + (limits.timeout + 300) * 1000 > deadline) {
          console.log('Run budget reached; remaining records stay queued');
          return;
        }
        const parsed = JSON.parse(row.download_sources_json || '{}');
        const sources = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.sources) ? parsed.sources : []);
        const qualities = sources.filter(s => /^(720p|1080p)$/.test(String(s.quality).toLowerCase()) && (!requestedQuality || String(s.quality).toLowerCase() === requestedQuality) && typeof s.r2StorageKey !== 'string').map(s => String(s.quality).toLowerCase());
        // Scope retries to this snapshot, never re-download ready rows or expand the batch.
        for (const quality of (qualities.length ? qualities : [undefined])) for (let attempt = 1; attempt <= 2; attempt++) {
          const token = randomUUID();
          console.log(`Transfer ${row.id}: attempt ${attempt}/2`);
          const scratch = await mkdtemp(join(tmpdir(), 'flixlyra-transfer-'));
          let result;
          try {
            result = await runChild([process.argv[1], `--transfer-id=${row.id}`, ...(quality ? [`--quality=${quality}`] : [])], {
              env: { ...process.env, TRANSFER_CHILD_TOKEN: token, TRANSFER_CHILD_DIRECTORY: scratch }, timeoutMs: (limits.timeout + 90) * 1000,
            });
          } finally {
            // Also clean up after a force-killed child, before starting another film.
            if (dirname(resolve(scratch)) === resolve(tmpdir()) && basename(scratch).startsWith('flixlyra-transfer-')) await rm(scratch, { recursive: true, force: true });
          }
          if (interrupted) return;
          const state = await sql(`SELECT ingest_status FROM movies WHERE id=${Number(row.id)}`);
          if (state[0]?.ingest_status === 'ready' || (quality && ['queued', 'processing'].includes(state[0]?.ingest_status))) break;
          const message = result.timedOut ? 'Isolated transfer timed out' : `Isolated transfer exited ${result.code ?? result.signal}`;
          // Recover only our own dead worker's lease; never overwrite another worker.
          await sql(`UPDATE movies SET ingest_status='failed', transfer_error=${quote(message)}, transfer_lease_until=NULL
            WHERE id=${Number(row.id)} AND transfer_token=${quote(token)} AND ingest_status='transferring'`);
          if (attempt < 2 && Date.now() + (limits.timeout + 300) * 1000 <= deadline) {
            const retry = await sql(`UPDATE movies SET ingest_status='processing', transfer_token=NULL WHERE id=${Number(row.id)}
              AND ingest_status='failed' AND (transfer_token=${quote(token)} OR transfer_token IS NULL) RETURNING id`);
            if (retry.length) continue;
          }
          process.exitCode = 1;
          console.error(`Unfinished: ${row.id}: ${message}; continuing batch`);
          break;
        }
      }
      if (!process.argv.includes('--watch')) break;
      await new Promise(resolve => setTimeout(resolve, 30000));
    } while (true);
  } finally { s3.destroy(); process.removeListener('SIGTERM', markInterrupted); process.removeListener('SIGINT', markInterrupted); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => {
    if (process.argv.some(arg => arg.startsWith('--transfer-id='))) process.exit(process.exitCode || 0);
  }).catch(error => { console.error(error.message); process.exitCode = 1;
    if (process.argv.some(arg => arg.startsWith('--transfer-id='))) process.exit(1);
  });
}
