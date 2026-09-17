import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  artworkSourceCandidates,
  context,
  downloadValidatedArtworkCandidate,
  fetchArtworkMetadata,
  fetchTmdbArtwork,
} from './prepare-cloud-media.mjs';
import { chooseBestArtworkCandidate, inspectArtworkBytes } from '../lib/artwork-quality.mjs';

const siteOrigin = (process.env.PUBLIC_SITE_ORIGIN || 'https://flixlyra.com').replace(/\/+$/, '');
const publicBase = (process.env.R2_PUBLIC_BASE_URL || `${siteOrigin}/media`).replace(/\/+$/, '');
const requestedKinds = process.argv.find((value) => value.startsWith('--kinds='))?.slice('--kinds='.length).split(',').map((value) => value.trim()).filter((value) => ['poster', 'backdrop'].includes(value)) || ['poster', 'backdrop'];
const args = new Set(process.argv.slice(2));
const execute = args.has('--execute');
const idsArg = process.argv.find((value) => value.startsWith('--ids='))?.slice('--ids='.length) || '';
const selectedIds = new Set(idsArg.split(',').map((value) => Number(value.trim())).filter((value) => Number.isSafeInteger(value) && value > 0));

function publicArtworkUrl(id, kind) {
  return `${publicBase}/artworks/${Number(id)}/${kind}.jpg`;
}

function artworkKey(id, kind) {
  return `artworks/${Number(id)}/${kind}.jpg`;
}

function isManagedArtworkUrl(value, id, kind) {
  if (typeof value !== 'string') return false;
  try {
    const current = new URL(value, siteOrigin);
    const expected = new URL(publicArtworkUrl(id, kind));
    return current.origin === expected.origin && current.pathname === expected.pathname;
  } catch {
    return false;
  }
}

function sourceReason(current, selected) {
  if (!current) return 'missing or invalid current artwork';
  if (selected.provider === 'tmdb') return 'superior trusted TMDB landscape/portrait candidate';
  if (selected.provider === 'yts') return 'superior trusted YTS candidate';
  return 'current artwork was not replaced';
}

async function fetchCurrentArtwork(row, kind) {
  const value = row[kind];
  if (!isManagedArtworkUrl(value, row.id, kind)) return null;
  const url = publicArtworkUrl(row.id, kind);
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) return null;
  const contentType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  const bytes = new Uint8Array(await response.arrayBuffer());
  const quality = inspectArtworkBytes(bytes, contentType, kind);
  return {
    provider: 'existing-r2',
    url,
    bytes,
    contentType,
    quality,
    identityCorrect: quality.valid,
  };
}

async function uploadAndVerify(ctx, row, kind, candidate) {
  const key = artworkKey(row.id, kind);
  await ctx.s3.send(new PutObjectCommand({
    Bucket: ctx.bucket,
    Key: key,
    Body: candidate.bytes,
    ContentType: candidate.contentType,
    CacheControl: 'public, max-age=31536000, immutable',
    Metadata: {
      source: `${candidate.provider}-artwork`,
      movieId: String(row.id),
      kind,
      artworkWidth: String(candidate.quality.width),
      artworkHeight: String(candidate.quality.height),
      artworkQualityScore: String(candidate.quality.score),
      artworkContentType: candidate.contentType,
    },
  }));
  const head = await ctx.headArtwork(key);
  if (!head || Number(head.ContentLength) !== candidate.bytes.byteLength || !String(head.ContentType || '').startsWith('image/')) {
    throw new Error(`R2_VERIFY_FAILED:${key}`);
  }
  const publicResponse = await fetch(publicArtworkUrl(row.id, kind), { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (!publicResponse.ok) throw new Error(`PUBLIC_ARTWORK_VERIFY_FAILED:${publicResponse.status}`);
  const publicType = (publicResponse.headers.get('content-type') || '').split(';')[0].toLowerCase();
  const publicBytes = new Uint8Array(await publicResponse.arrayBuffer());
  const publicQuality = inspectArtworkBytes(publicBytes, publicType, kind);
  if (!publicQuality.valid || publicBytes.byteLength !== candidate.bytes.byteLength) throw new Error(`PUBLIC_ARTWORK_QUALITY_VERIFY_FAILED:${key}`);
}

async function repairRow(ctx, row) {
  const yts = await fetchArtworkMetadata(row.imdb_id);
  const tmdb = await fetchTmdbArtwork(row);
  const changes = [];
  const classifications = [];
  for (const kind of requestedKinds) {
    const current = await fetchCurrentArtwork(row, kind);
    const candidates = [];
    if (current?.quality?.valid) candidates.push(current);
    for (const source of artworkSourceCandidates(kind, row, yts, tmdb)) {
      if (source.provider === 'current') continue;
      try {
        candidates.push(await downloadValidatedArtworkCandidate(source, kind));
      } catch (error) {
        console.warn(JSON.stringify({ event: 'repair-candidate-rejected', id: row.id, kind, provider: source.provider, error: String(error?.message || error) }));
      }
    }
    const selected = chooseBestArtworkCandidate(kind, candidates, current);
    const needsRepair = !current?.quality?.valid || (selected && selected.provider !== 'existing-r2');
    const classification = needsRepair && selected ? 'REPAIR_REQUIRED' : current?.quality?.valid ? 'GOOD_PRESERVE' : 'MANUAL_REVIEW';
    classifications.push({
      kind,
      classification,
      current: current ? { source: current.provider, width: current.quality.width, height: current.quality.height, bytes: current.quality.bytes, score: current.quality.score } : null,
      selected: selected ? { source: selected.provider, width: selected.quality.width, height: selected.quality.height, bytes: selected.quality.bytes, score: selected.quality.score } : null,
      reason: selected && selected.provider !== 'existing-r2' ? sourceReason(current, selected) : classification,
    });
    if (!needsRepair || !selected || selected.provider === 'existing-r2') continue;
    if (!execute) {
      changes.push({ kind, before: current, after: selected, uploaded: false });
      continue;
    }
    await uploadAndVerify(ctx, row, kind, selected);
    changes.push({ kind, before: current, after: selected, uploaded: true, reference: publicArtworkUrl(row.id, kind) });
  }
  if (execute && changes.length) {
    const assignments = changes.map((change) => `${change.kind}=?`);
    const params = changes.map((change) => change.reference);
    const updated = await ctx.query(
      `UPDATE movies SET ${assignments.join(',')} WHERE id=? AND revision=? AND publication_status IN ('draft','published') RETURNING id`,
      [...params, row.id, row.revision],
    );
    if (!updated.length) throw new Error(`D1_ARTWORK_UPDATE_CONFLICT:${row.id}`);
  }
  return { id: row.id, title: row.title, imdbId: row.imdb_id, publicationStatus: row.publication_status, classifications, changes: changes.map((change) => ({
    kind: change.kind,
    before: change.before ? { source: change.before.provider, width: change.before.quality.width, height: change.before.quality.height, bytes: change.before.quality.bytes } : null,
    after: { source: change.after.provider, width: change.after.quality.width, height: change.after.quality.height, bytes: change.after.quality.bytes },
    reference: change.reference || null,
    reason: sourceReason(change.before, change.after),
  })) };
}

const ctx = await context();
try {
  const where = selectedIds.size ? `id IN (${[...selectedIds].map(() => '?').join(',')})` : "publication_status IN ('draft','published')";
  const params = selectedIds.size ? [...selectedIds] : [];
  const rows = await ctx.query(`SELECT id, revision, imdb_id, title, publication_status, poster, backdrop FROM movies WHERE ${where} ORDER BY id`, params);
  const results = [];
  for (const row of rows) {
    try {
      results.push(await repairRow(ctx, row));
    } catch (error) {
      results.push({ id: row.id, title: row.title, error: String(error?.message || error) });
    }
  }
  console.log(JSON.stringify({ event: 'artwork-repair-complete', mode: execute ? 'execute' : 'dry-run', rows: results.length, results }, null, 2));
  if (results.some((result) => result.error)) process.exitCode = 1;
} finally {
  ctx.s3?.destroy?.();
}