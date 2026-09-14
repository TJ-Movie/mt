import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SITE_ORIGIN = (process.env.PUBLIC_SITE_ORIGIN || process.env.R2_PUBLIC_ORIGIN || 'https://flixlyra.com').replace(/\/+$/, '');
const DATABASE_NAME = process.env.D1_DATABASE_NAME || 'flixlyra-db';
const WRANGLER_CONFIG = process.env.WRANGLER_CONFIG || 'wrangler.json';
const EXPECTED_MOVIE_COUNT = 30;
const RANGE_HEADER = 'bytes=0-1024';
const MIN_VIDEO_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RATE_LIMIT_RETRIES = 2;

const trim = value => typeof value === 'string' ? value.trim() : '';
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const parseJson = value => { try { return JSON.parse(value || '{}'); } catch { return null; } };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function sourcesOf(value) {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed : Array.isArray(parsed?.sources) ? parsed.sources : [];
}
function sourceQuality(source) { return trim(object(source).quality || object(source).resolution).toLowerCase(); }
function sourceKey(source) {
  const item = object(source);
  return trim(item.r2StorageKey ?? item.r2_storage_key ?? item.r2Key ?? item.storageKey) || null;
}
function publicMediaUrl(key) {
  const value = trim(key);
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return SITE_ORIGIN + '/media/' + value.replace(/^\/+/, '').replace(/^media\//i, '');
}
function targetsFor(row) {
  const targets = { '720p': null, '1080p': null };
  for (const source of sourcesOf(row.download_sources_json)) {
    const quality = sourceQuality(source);
    if (quality !== '720p' && quality !== '1080p') continue;
    const key = sourceKey(source);
    if (key && !targets[quality]) targets[quality] = { key, url: publicMediaUrl(key), expectedBytes: Number(object(source).r2Bytes || 0) || null };
  }
  return targets;
}
function parseWranglerJson(output) {
  const start = output.indexOf('[');
  if (start < 0) throw new Error('Wrangler D1 query did not return JSON');
  const parsed = JSON.parse(output.slice(start));
  const result = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!result?.success || !Array.isArray(result.results)) throw new Error('Wrangler D1 query failed');
  return result.results;
}
async function queryD1(sql) {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.R2_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_D1_TOKEN || process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID || process.env.D1_DATABASE_ID || 'a8e45cf6-effe-430f-9f7d-3ff85aea0acc';
  if (account && token) {
    const response = await fetch('https://api.cloudflare.com/client/v4/accounts/' + account + '/d1/database/' + databaseId + '/query', {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ sql, params: [] }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.success) throw new Error('D1_HTTP_' + response.status);
    return body.result?.[0]?.results || [];
  }
  const wranglerSql = sql.replace(/\s+/g, '/**/');
  const command = 'npm.cmd exec wrangler -- d1 execute ' + DATABASE_NAME + ' --remote --config ' + WRANGLER_CONFIG + ' --command ' + wranglerSql + ' --json';
  const executable = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'sh';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
  const { stdout } = await execFileAsync(executable, args, { windowsHide: true, maxBuffer: 20 * 1024 * 1024, timeout: REQUEST_TIMEOUT_MS * 2 });
  return parseWranglerJson(stdout);
}
function videoTypeOkay(value) {
  const type = trim(value).toLowerCase().split(';', 1)[0];
  return type.startsWith('video/') || type === 'application/x-mpegurl' || type === 'application/vnd.apple.mpegurl';
}
function totalBytes(response) {
  const match = /\/([0-9]+)$/.exec(response.headers.get('content-range') || '');
  return match ? Number(match[1]) : Number(response.headers.get('content-length') || 0);
}
async function cancelBody(response) { await response.body?.cancel().catch(() => {}); }
async function probeBody(response) {
  if (!response.body) return 0;
  const reader = response.body.getReader();
  try { return (await reader.read()).value?.byteLength || 0; }
  finally { await reader.cancel().catch(() => {}); }
}
async function request(url, options) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, options);
    if (response.status !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) return response;
    const retryAfter = Number(response.headers.get('retry-after') || 0);
    await cancelBody(response);
    await wait(Math.min(10_000, Math.max(1000, retryAfter * 1000 || 1000 * (attempt + 1))));
  }
}
async function signedUrlFor(row, quality) {
  const slug = trim(row.slug);
  if (!slug) return { url: null, status: 'MISSING', reason: 'missing movie slug' };
  const endpoint = SITE_ORIGIN + '/api/download/resolve?slug=' + encodeURIComponent(slug) + '&quality=' + quality;
  try {
    const response = await request(endpoint, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const location = response.headers.get('location');
    const status = response.status;
    await cancelBody(response);
    if (!location || status < 300 || status >= 400) return { url: null, status, reason: 'RESOLVER_HTTP_' + status + (location ? '' : '_NO_SIGNED_LOCATION') };
    const signed = new URL(location, endpoint);
    if (signed.protocol !== 'https:') return { url: null, status, reason: 'RESOLVER_SIGNED_URL_NOT_HTTPS' };
    return { url: signed.toString(), status, reason: '' };
  } catch (error) {
    return { url: null, status: 'ERROR', reason: error?.name === 'TimeoutError' ? 'RESOLVER_NETWORK_TIMEOUT_15S' : 'RESOLVER_NETWORK_ERROR:' + (error?.message || error) };
  }
}
async function auditStream(row, quality, target) {
  if (!target?.key) return { ok: false, status: 'MISSING', contentType: '', reason: 'missing R2 quality storage key' };
  const signed = await signedUrlFor(row, quality);
  if (!signed.url) return { ok: false, status: signed.status, contentType: '', reason: signed.reason };
  try {
    const response = await request(signed.url, { method: 'GET', redirect: 'follow', headers: { range: RANGE_HEADER }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const contentType = trim(response.headers.get('content-type')).toLowerCase();
    const bytes = totalBytes(response);
    const probeBytes = await probeBody(response);
    const ok = (response.status === 206 || response.status === 200) && videoTypeOkay(contentType) && probeBytes > 0 && bytes > MIN_VIDEO_BYTES;
    const reason = ok ? '' : [
      response.status !== 206 && response.status !== 200 ? 'HTTP_' + response.status : '',
      !videoTypeOkay(contentType) ? 'INVALID_CONTENT_TYPE:' + (contentType || 'missing') : '',
      !probeBytes ? 'EMPTY_BODY' : '',
      !(bytes > MIN_VIDEO_BYTES) ? 'PAYLOAD_TOO_SMALL:' + (bytes || 0) : '',
    ].filter(Boolean).join(',');
    return { ok, status: response.status, contentType, bytes, probeBytes, finalUrl: response.url, reason };
  } catch (error) {
    return { ok: false, status: 'ERROR', contentType: '', reason: error?.name === 'TimeoutError' ? 'NETWORK_TIMEOUT_15S' : 'NETWORK_ERROR:' + (error?.message || error) };
  }
}
function youtubeUrl(value) {
  const candidate = trim(value);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    const host = parsed.hostname.toLowerCase();
    return host.endsWith('youtube.com') || host === 'youtu.be' ? parsed.toString() : null;
  } catch { return null; }
}
async function auditWatch(value) {
  const url = youtubeUrl(value);
  if (!url) return { ok: false, reason: 'missing_or_non_youtube_url' };
  try {
    const live = await request(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    await cancelBody(live);
    const oembed = await request('https://www.youtube.com/oembed?url=' + encodeURIComponent(url) + '&format=json', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    await cancelBody(oembed);
    const ok = live.status >= 200 && live.status < 300 && oembed.status === 200;
    return { ok, reason: ok ? '' : 'LIVE_' + live.status + '_OEMBED_' + oembed.status };
  } catch (error) {
    return { ok: false, reason: error?.name === 'TimeoutError' ? 'WATCH_NETWORK_TIMEOUT_15S' : 'WATCH_NETWORK_ERROR:' + (error?.message || error) };
  }
}
function reportRow(row, targets, checks, watch) {
  return {
    id: row.id,
    title: row.title,
    '720p_stream': checks['720p'].ok ? 'PASS' : targets['720p'] ? 'FAIL' : 'MISSING',
    '1080p_stream': checks['1080p'].ok ? 'PASS' : targets['1080p'] ? 'FAIL' : 'MISSING',
    http_status: checks['720p'].status + '/' + checks['1080p'].status,
    content_type: (checks['720p'].contentType || '-') + '/' + (checks['1080p'].contentType || '-'),
    stream_status: checks['720p'].ok && checks['1080p'].ok && watch.ok ? 'PASS' : 'FAIL',
  };
}
async function main() {
  const rows = await queryD1('SELECT id,slug,title,official_watch_url,storage_key,r2_storage_key,r2_video_bytes,download_sources_json FROM movies ORDER BY id');
  const failures = [];
  if (rows.length !== EXPECTED_MOVIE_COUNT) failures.push({ scope: 'database', reason: 'EXPECTED_' + EXPECTED_MOVIE_COUNT + '_MOVIES_GOT_' + rows.length });
  const report = [];
  for (const row of rows) {
    const targets = targetsFor(row);
    const checks = { '720p': await auditStream(row, '720p', targets['720p']), '1080p': await auditStream(row, '1080p', targets['1080p']) };
    const watch = await auditWatch(row.official_watch_url);
    const reasons = ['720p', '1080p'].filter(q => !checks[q].ok).map(q => q + ':' + checks[q].reason);
    if (!watch.ok) reasons.push('watch:' + watch.reason);
    if (reasons.length) {
      const detail = { id: row.id, title: row.title, failures: reasons, keys: { '720p': targets['720p']?.key || null, '1080p': targets['1080p']?.key || null } };
      failures.push(detail);
      console.error('STREAM_AUDIT_FAILURE ' + JSON.stringify(detail));
    }
    report.push(reportRow(row, targets, checks, watch));
  }
  console.table(report);
  console.log('AUDIT_SUMMARY movies=' + rows.length + ' failures=' + failures.length + ' site=' + SITE_ORIGIN);
  if (failures.length) { console.error('PRODUCTION_STREAM_AUDIT_FAILED unresolved=' + failures.length); process.exitCode = 1; }
  else console.log('PRODUCTION_STREAM_AUDIT_PASSED');
}
main().catch(error => { console.error('PRODUCTION_STREAM_AUDIT_FATAL ' + (error?.message || error)); process.exitCode = 1; });