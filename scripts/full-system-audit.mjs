#!/usr/bin/env node
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 3;
const MIN_VIDEO_BYTES = 1024 * 1024;
const MAX_PROBE_BYTES = 1024 * 1024;
const SITE_ORIGIN = (process.env.PUBLIC_SITE_ORIGIN || "https://flixlyra.com").replace(/\/+$/, "");
const DEFAULT_DATABASE_ID = "a8e45cf6-effe-430f-9f7d-3ff85aea0acc";
const MEDIA_QUALITIES = ["720p", "1080p"];
const TERMINAL_MEDIA_FAILURE_STATUSES = new Set(["failed", "unavailable", "skipped_unplayable"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(url, init = {}) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("request timeout")), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.status !== 429 && response.status < 500) return response;
      if (attempt === MAX_ATTEMPTS) return response;
      await response.body?.cancel().catch(() => {});
      await sleep(response.status === 429 ? 2000 : 500 * (2 ** (attempt - 1)));
    } catch (error) {
      lastError = error;
      if (attempt === MAX_ATTEMPTS) throw error;
      await sleep(500 * (2 ** (attempt - 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("request failed");
}

function d1Config() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.R2_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_D1_TOKEN || process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  const database = process.env.CLOUDFLARE_D1_DATABASE_ID || process.env.CLOUDFLARE_DATABASE_ID || process.env.D1_DATABASE_ID || DEFAULT_DATABASE_ID;
  if (!account || !token) throw new Error("CLOUDFLARE_ACCOUNT_ID and a Cloudflare D1 API token are required");
  return { account, token, database };
}

async function queryD1(sql, params = []) {
  const config = d1Config();
  const response = await request("https://api.cloudflare.com/client/v4/accounts/" + config.account + "/d1/database/" + config.database + "/query", {
    method: "POST",
    headers: { Authorization: "Bearer " + config.token, "content-type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true) throw new Error("D1 query failed: HTTP " + response.status);
  return (Array.isArray(payload.result) ? payload.result : []).flatMap((entry) => entry?.results || []);
}

let r2Client;
let r2Bucket;
function r2Config() {
  const account = process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME || "flixlyra-media";
  if (!account || !accessKeyId || !secretAccessKey || !bucket) throw new Error("R2 audit credentials are required");
  return { account, accessKeyId, secretAccessKey, bucket };
}

function getR2Client() {
  if (!r2Client) {
    const config = r2Config();
    r2Bucket = config.bucket;
    r2Client = new S3Client({
      region: "auto",
      endpoint: "https://" + config.account + ".r2.cloudflarestorage.com",
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }
  return r2Client;
}

async function headR2Object(key) {
  try {
    const object = await getR2Client().send(new HeadObjectCommand({ Bucket: r2Bucket, Key: key }));
    return {
      exists: true,
      contentLength: Number(object.ContentLength),
      contentType: String(object.ContentType || "").split(";")[0].trim().toLowerCase(),
    };
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (status === 404 || error?.name === "NotFound" || error?.name === "NoSuchKey") return { exists: false, reason: "r2_object_missing" };
    throw new Error("R2_HEAD_FAILED");
  }
}

async function readSmallBody(response) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < MAX_PROBE_BYTES) {
      const part = await reader.read();
      if (part.done) break;
      if (part.value?.length) {
        const remaining = MAX_PROBE_BYTES - total;
        chunks.push(Buffer.from(part.value.subarray(0, remaining)));
        total += Math.min(part.value.length, remaining);
      }
      if (total >= MAX_PROBE_BYTES) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

function contentType(response) {
  return (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
}

async function auditImage(url, label) {
  if (typeof url !== "string" || !url.trim()) return { ok: false, reason: label + "_missing" };
  try {
    const response = await request(url, { redirect: "follow", headers: { accept: "image/*" } });
    const type = contentType(response);
    const body = await readSmallBody(response);
    if (response.status !== 200) return { ok: false, reason: label + "_http_" + response.status };
    if (!type.startsWith("image/")) return { ok: false, reason: label + "_content_type_" + (type || "missing") };
    if (!body.length) return { ok: false, reason: label + "_empty_body" };
    return { ok: true, status: response.status, type, bytes: body.length };
  } catch (error) {
    return { ok: false, reason: label + "_" + String(error.message || error) };
  }
}

function youtubeUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    const host = parsed.hostname.toLowerCase();
    if (!["youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com", "youtu.be"].includes(host)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

async function auditTrailer(value) {
  const url = youtubeUrl(value);
  if (!url) return { ok: false, reason: "missing_or_non_youtube_url" };
  try {
    const endpoint = "https://www.youtube.com/oembed?url=" + encodeURIComponent(url) + "&format=json";
    const response = await request(endpoint, { headers: { accept: "application/json" } });
    await response.body?.cancel().catch(() => {});
    return response.status === 200 ? { ok: true, status: 200 } : { ok: false, reason: "oembed_http_" + response.status };
  } catch (error) {
    return { ok: false, reason: "oembed_" + String(error.message || error) };
  }
}

function parseSources(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value || "null") : value;
    if (Array.isArray(parsed)) return parsed;
    return Array.isArray(parsed?.sources) ? parsed.sources : [];
  } catch {
    return [];
  }
}

function sourceFor(sources, quality) {
  return sources.find((source) => String(source?.quality || source?.resolution || "").toLowerCase() === quality) || null;
}

function sourceKey(source) {
  return typeof source?.r2StorageKey === "string" ? source.r2StorageKey : typeof source?.r2_storage_key === "string" ? source.r2_storage_key : typeof source?.storageKey === "string" ? source.storageKey : null;
}

function sourceBytes(source) {
  const value = source?.r2Bytes ?? source?.r2_video_bytes ?? source?.bytes;
  const bytes = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

function sourceHasManagedFields(source) {
  return Boolean(sourceKey(source) || sourceBytes(source));
}

function qualitySources(row) {
  const sources = parseSources(row.download_sources_json).concat(parseSources(row.streaming_sources_json));
  return new Map(MEDIA_QUALITIES.map((quality) => [quality, sources.filter((source) => String(source?.quality || source?.resolution || "").toLowerCase() === quality)]));
}

function mediaFailures(row) {
  try {
    const parsed = JSON.parse(row.transfer_error || "null");
    if (!parsed || parsed.type !== "MEDIA_FAILURES" || !Array.isArray(parsed.qualities)) return new Map();
    return new Map(parsed.qualities
      .filter((failure) => failure && MEDIA_QUALITIES.includes(String(failure.quality).toLowerCase()) && typeof failure.failure_code === "string" && typeof failure.failure_stage === "string")
      .map((failure) => [String(failure.quality).toLowerCase(), failure]));
  } catch {
    return new Map();
  }
}

function publicMediaExpected(row) {
  return String(row.publication_status || "").toLowerCase() === "published" && String(row.rights_status || "").toLowerCase() === "verified";
}

function activeTransfer(row) {
  const token = typeof row.transfer_token === "string" ? row.transfer_token.trim() : "";
  const leaseUntil = Number(row.transfer_lease_until);
  return Boolean(token) || (Number.isFinite(leaseUntil) && leaseUntil > Math.floor(Date.now() / 1000));
}

function sourceUrl(row, source, quality) {
  const direct = source?.download_url || source?.downloadUrl;
  if (typeof direct === "string" && direct.trim()) {
    try { return new URL(direct, SITE_ORIGIN).toString(); } catch { return null; }
  }
  if (!row.slug || !sourceKey(source)) return null;
  return SITE_ORIGIN + "/api/download/resolve?slug=" + encodeURIComponent(row.slug) + "&quality=" + quality;
}

async function getRedirectTarget(url, headers = {}) {
  let current = url;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await request(current, { redirect: "manual", headers });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location || redirects === 3) return { ok: false, reason: "redirect_limit_or_missing_location" };
      current = new URL(location, current).toString();
      continue;
    }
    return { ok: true, response, url: current };
  }
  return { ok: false, reason: "redirect_limit" };
}

async function auditQualityMapping(quality, source, headObject = headR2Object) {
  const key = sourceKey(source);
  const bytes = sourceBytes(source);
  if (!key || !bytes) return { ok: false, reason: quality + "_mapping_missing", key, bytes };
  try {
    const object = await headObject(key);
    if (!object?.exists) return { ok: false, reason: quality + "_r2_object_missing", key, bytes };
    const contentLength = Number(object.contentLength ?? object.ContentLength);
    const contentType = String(object.contentType ?? object.ContentType ?? "").split(";")[0].trim().toLowerCase();
    if (contentLength !== bytes) return { ok: false, reason: quality + "_r2_size_mismatch", key, bytes };
    if (!contentType.startsWith("video/")) return { ok: false, reason: quality + "_r2_content_type_invalid", key, bytes };
    return { ok: true, key, bytes, contentType };
  } catch (error) {
    return { ok: false, reason: quality + "_r2_head_failed", key, bytes, error: String(error?.message || error) };
  }
}

async function auditVideo(row, quality) {
  const sources = parseSources(row.download_sources_json).concat(parseSources(row.streaming_sources_json));
  const source = sourceFor(sources, quality);
  const key = sourceKey(source);
  const url = sourceUrl(row, source, quality);
  if (!source || !key) return { ok: false, reason: quality + "_key_missing", status: "MISSING", url: url || "" };
  if (!url) return { ok: false, reason: quality + "_download_url_missing", status: "MISSING", url: "" };
  try {
    const resolved = await getRedirectTarget(url, { Range: "bytes=0-1024", accept: "video/*,application/x-mpegURL" });
    if (!resolved.ok) return { ok: false, reason: quality + "_" + resolved.reason, status: "FAIL", url };
    const final = resolved.response;
    const type = contentType(final);
    const statusOk = final.status === 206;
    const isVideo = type.startsWith("video/") || type === "application/x-mpegurl" || type === "application/vnd.apple.mpegurl";
    const contentRange = final.headers.get("content-range") || "";
    const rangeMatch = contentRange.match(/\/(\d+)$/);
    const totalBytes = rangeMatch ? Number(rangeMatch[1]) : Number(final.headers.get("content-length") || 0);
    const body = await readSmallBody(final);
    if (!statusOk) return { ok: false, reason: quality + (final.status === 200 ? "_range_http_200" : "_http_" + final.status), status: String(final.status), url };
    if (!isVideo) return { ok: false, reason: quality + "_content_type_" + (type || "missing"), status: String(final.status), url };
    if (!body.length) return { ok: false, reason: quality + "_empty_probe", status: String(final.status), url };
    if (!Number.isFinite(totalBytes) || totalBytes <= MIN_VIDEO_BYTES) return { ok: false, reason: quality + "_payload_not_over_1MB", status: String(final.status), url };
    return { ok: true, reason: "", status: String(final.status), type, bytes: totalBytes, url };
  } catch (error) {
    return { ok: false, reason: quality + "_" + String(error.message || error), status: "ERROR", url };
  }
}

function castEntries(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value || "[]") : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function castProfileUrl(entry) {
  const value = entry?.profile_url || entry?.profileUrl || entry?.image;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:") return null;
    const host = parsed.hostname.toLowerCase();
    if (!["image.tmdb.org", "m.media-amazon.com", "img.yts.mx", "yts.mx", "yts.lt"].includes(host)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function castProfileR2Key(entry) {
  const value = entry?.profileR2Key || entry?.profile_r2_key;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function validCastProfileR2Key(row, index, value) {
  return typeof value === 'string' && value === 'cast/' + row.imdb_id + '-' + (index + 1) + '.jpg' && /^tt\d{7,10}$/.test(String(row.imdb_id || '')) && index < 6;
}

async function auditCast(row, options = {}) {
  const auditImageFn = options.auditImage || auditImage;
  const headR2ObjectFn = options.headR2Object || headR2Object;
  const cast = castEntries(row.cast_json);
  if (!cast.length) return { ok: false, reason: "cast_empty" };
  const failures = [];
  for (const [index, entry] of cast.entries()) {
    const name = entry?.name || entry?.actor;
    const label = 'cast_' + index;
    const r2Key = castProfileR2Key(entry);
    if (r2Key) {
      if (!validCastProfileR2Key(row, index, r2Key)) {
        failures.push(label + '_profile_r2_invalid_path');
        continue;
      }
      try {
        const object = await headR2ObjectFn(r2Key);
        const exists = object?.exists ?? object?.Exists;
        const bytes = Number(object?.contentLength ?? object?.ContentLength);
        const type = String(object?.contentType ?? object?.ContentType ?? '').split(';')[0].trim().toLowerCase();
        if (!exists) failures.push(label + '_profile_r2_object_missing');
        else if (!Number.isFinite(bytes) || bytes <= 0) failures.push(label + '_profile_r2_object_empty');
        else if (!type.startsWith('image/')) failures.push(label + '_profile_r2_content_type_invalid');
      } catch {
        failures.push(label + '_profile_r2_head_failed');
      }
      continue;
    }
    const profile = castProfileUrl(entry);
    if (typeof name !== "string" || name.trim().length < 2) failures.push("cast_" + index + "_name");
    if (!profile) { failures.push("cast_" + index + "_profile_missing"); continue; }
    const result = await auditImageFn(profile, "cast_" + index);
    if (!result.ok) failures.push(result.reason);
  }
  return failures.length ? { ok: false, reason: failures.join("|") } : { ok: true, reason: "" };
}

function validDirector(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length >= 3 && !["pending editorial review", "me", "mee"].includes(normalized);
}

export async function auditMovie(row, options = {}) {
  const reasons = [];
  const auditImageFn = options.auditImage || auditImage;
  const auditTrailerFn = options.auditTrailer || auditTrailer;
  const auditVideoFn = options.auditVideo || auditVideo;
  const headObject = options.headR2Object || headR2Object;
  const sourceMap = qualitySources(row);
  const verifiedSources = new Map(MEDIA_QUALITIES.map((quality) => [quality, (sourceMap.get(quality) || []).find((source) => sourceKey(source) && sourceBytes(source)) || null]));
  const managedSources = new Map(MEDIA_QUALITIES.map((quality) => [quality, (sourceMap.get(quality) || []).find(sourceHasManagedFields) || null]));
  const claimedQualities = MEDIA_QUALITIES.filter((quality) => verifiedSources.get(quality));
  const status = String(row.ingest_status || "").toLowerCase();
  const terminalFailure = TERMINAL_MEDIA_FAILURE_STATUSES.has(status);
  let mediaState = null;
  let requiredQualities = [];

  if (status === "ready") {
    mediaState = "READY";
    requiredQualities = MEDIA_QUALITIES;
    if (claimedQualities.length !== 2) reasons.push("ready_verified_quality_count_" + claimedQualities.length);
  } else if (status === "half") {
    mediaState = "HALF";
    requiredQualities = claimedQualities.length === 1 ? claimedQualities : [];
    if (claimedQualities.length !== 1) reasons.push("half_verified_quality_count_" + claimedQualities.length);
  } else if (terminalFailure) {
    mediaState = "FAILED";
    if (claimedQualities.length !== 0) reasons.push("failed_state_claims_verified_media");
    for (const quality of MEDIA_QUALITIES) {
      if (managedSources.get(quality)) reasons.push(quality + "_managed_mapping_present_in_failed_state");
    }
    const failures = mediaFailures(row);
    for (const quality of MEDIA_QUALITIES) {
      if (!failures.has(quality)) reasons.push("missing_terminal_diagnostic_" + quality);
    }
  } else {
    reasons.push("unsupported_media_state_" + (status || "missing"));
  }

  if (activeTransfer(row)) reasons.push("active_transfer_lease_or_token");

  const mappingChecks = new Map();
  for (const quality of claimedQualities) {
    const result = await auditQualityMapping(quality, verifiedSources.get(quality), headObject);
    mappingChecks.set(quality, result);
    if (!result.ok) reasons.push(result.reason);
  }

  const publicExpected = publicMediaExpected(row);
  let downloadOk = "NOT_EXPECTED";
  let signedStatus = "NOT_EXPECTED";
  if (publicExpected && requiredQualities.length) {
    const publicChecks = new Map();
    for (const quality of requiredQualities) {
      const result = await auditVideoFn(row, quality);
      publicChecks.set(quality, result);
      if (!result.ok) reasons.push(result.reason);
    }
    downloadOk = [...publicChecks.values()].every((result) => result.ok) ? "PASS" : "FAIL";
    signedStatus = [...publicChecks.values()].every((result) => result.ok)
      ? "PASS (" + [...publicChecks.values()].map((result) => result.status || "206").join("/") + ")"
      : "FAIL";
  }

  const enrichmentExpected = mediaState === "READY" || mediaState === "HALF";
  let castStatus = "NOT_EXPECTED";
  let artworkStatus = "NOT_EXPECTED";
  let trailerStatus = "NOT_EXPECTED";
  if (enrichmentExpected) {
    const cast = await auditCast(row, { auditImage: auditImageFn, headR2Object: headObject });
    if (!cast.ok) reasons.push(cast.reason);
    castStatus = cast.ok ? "PASS" : "FAIL";
    const poster = await auditImageFn(SITE_ORIGIN + "/media/artworks/" + row.id + "/poster.jpg", "poster");
    const backdrop = await auditImageFn(SITE_ORIGIN + "/media/artworks/" + row.id + "/backdrop.jpg", "backdrop");
    if (!poster.ok) reasons.push(poster.reason);
    if (!backdrop.ok) reasons.push(backdrop.reason);
    artworkStatus = poster.ok && backdrop.ok ? "PASS" : "FAIL";
    const trailer = await auditTrailerFn(row.official_watch_url);
    if (!trailer.ok) reasons.push("trailer_" + trailer.reason);
    trailerStatus = trailer.ok ? "PASS" : "FAIL";
    if (!validDirector(row.director)) reasons.push("director_invalid");
  }

  const r2MediaOk = requiredQualities.length > 0 && requiredQualities.every((quality) => mappingChecks.get(quality)?.ok);
  return {
    ID: row.id,
    Title: String(row.title || "").slice(0, 50),
    Media_State: mediaState || "INVALID",
    Video_Streaming: requiredQualities.length ? (r2MediaOk ? "PASS" : "FAIL") : mediaState === "FAILED" ? "NOT_EXPECTED" : "FAIL",
    Download_Links: downloadOk,
    Cast_Profile_Photos: castStatus,
    Poster_Backdrop: artworkStatus,
    Trailer_Watch: trailerStatus,
    Signed_HTTP_206: signedStatus,
    Final_State: reasons.length ? "FAIL" : "PASS",
    reasons,
  };
}

async function main() {
  const rows = await queryD1("SELECT id,slug,title,director,cast_json,poster,backdrop,official_watch_url,publication_status,rights_status,ingest_status,transfer_token,transfer_lease_until,transfer_error,download_sources_json,streaming_sources_json FROM movies ORDER BY id");
  const results = [];
  for (const row of rows) {
    try {
      results.push(await auditMovie(row));
    } catch (error) {
      results.push({ ID: row.id, Title: String(row.title || "").slice(0, 50), Media_State: "ERROR", Video_Streaming: "ERROR", Download_Links: "ERROR", Cast_Profile_Photos: "ERROR", Poster_Backdrop: "ERROR", Trailer_Watch: "ERROR", Signed_HTTP_206: "ERROR", Final_State: "FAIL", reasons: [String(error.message || error)] });
    }
  }
  console.table(results.map(({ reasons, ...row }) => row));
  const failures = results.filter((row) => row.Final_State !== "PASS");
  for (const row of failures) console.error(JSON.stringify({ event: "movie_audit_failure", id: row.ID, title: row.Title, reasons: row.reasons }));
  console.log(JSON.stringify({ event: "full_system_audit_complete", movies: rows.length, passed: rows.length - failures.length, failed: failures.length }));
  if (failures.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: "full_system_audit_fatal", error: String(error) }));
    process.exitCode = 1;
  });
}
