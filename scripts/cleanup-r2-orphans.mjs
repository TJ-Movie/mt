#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";

const REQUEST_TIMEOUT_MS = 10000;
const MAX_ATTEMPTS = 3;
const DELETE_BATCH_SIZE = 1000;
const MAX_MANAGED_KEY = /^(?:artworks\/\d+\/(?:poster|backdrop)\.jpg|assets\/[A-Za-z0-9-]+\/(?:data\.bin|720p\.mp4|1080p\.mp4)|subtitles\/.+|descriptors\/.+|movie-art\/.+|posters\/.+|backdrops\/.+|cast\/.+|movies\/.+|media\/.+)$/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseEnv(text) {
  const values = {};
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const match = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

async function loadLocalEnv() {
  try {
    const values = parseEnv(await readFile(".env.r2-upload.local", "utf8"));
    for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"]) {
      if (!process.env[name] && values[name]) process.env[name] = values[name];
    }
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn(JSON.stringify({ event: "cleanup-env-warning", reason: String(error) }));
  }
}

async function fetchWithRetry(url, init = {}) {
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

async function sendWithRetry(client, command) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("R2 request timeout")), REQUEST_TIMEOUT_MS);
    try {
      return await client.send(command, { abortSignal: controller.signal });
    } catch (error) {
      lastError = error;
      const status = error?.$metadata?.httpStatusCode;
      if (attempt === MAX_ATTEMPTS || (status && status < 500 && status !== 429)) throw error;
      await sleep(status === 429 ? 2000 : 500 * (2 ** (attempt - 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("R2 request failed");
}

function databaseConfig() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.R2_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_D1_TOKEN || process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  const database = process.env.CLOUDFLARE_D1_DATABASE_ID || process.env.CLOUDFLARE_DATABASE_ID || process.env.D1_DATABASE_ID || "a8e45cf6-effe-430f-9f7d-3ff85aea0acc";
  if (!account || !token) throw new Error("CLOUDFLARE_ACCOUNT_ID and a Cloudflare D1 API token are required");
  return { account, token, database };
}

async function queryD1(sql, params = []) {
  const config = databaseConfig();
  const response = await fetchWithRetry("https://api.cloudflare.com/client/v4/accounts/" + config.account + "/d1/database/" + config.database + "/query", {
    method: "POST",
    headers: { Authorization: "Bearer " + config.token, "content-type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true) throw new Error("D1 query failed: HTTP " + response.status);
  const result = Array.isArray(payload.result) ? payload.result : [];
  return result.flatMap((entry) => Array.isArray(entry?.results) ? entry.results : []);
}

function canonicalKey(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let candidate = value.trim();
  try {
    const parsed = new URL(candidate);
    if (parsed.pathname.startsWith("/media/")) candidate = parsed.pathname.slice("/media/".length);
    else return null;
  } catch {
    if (candidate.startsWith("/media/")) candidate = candidate.slice("/media/".length);
  }
  return MAX_MANAGED_KEY.test(candidate) ? candidate : null;
}

function collectKeys(keys, value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === "string") {
    const key = canonicalKey(value);
    if (key) keys.add(key);
    if (MAX_MANAGED_KEY.test(value.trim())) keys.add(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 500)) collectKeys(keys, item, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value).slice(0, 200)) collectKeys(keys, item, depth + 1);
  }
}

function movieKeys(row) {
  const keys = new Set();
  for (const value of [row.poster, row.backdrop, row.subtitle_url, row.storage_key, row.r2_storage_key]) collectKeys(keys, value);
  for (const field of ["cast_json", "episodes_json", "download_sources_json", "streaming_sources_json"]) {
    try { collectKeys(keys, JSON.parse(row[field] || "null")); } catch { /* Ignore malformed JSON. */ }
  }
  return keys;
}

async function listAllObjects(client, bucket) {
  const objects = [];
  let token;
  do {
    const page = await sendWithRetry(client, new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const object of page.Contents || []) if (object.Key) objects.push({ key: object.Key, bytes: Number(object.Size || 0) });
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return objects;
}

async function main() {
  await loadLocalEnv();
  const account = process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET_NAME;
  if (!account || !bucket || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    throw new Error("R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required");
  }
  const client = new S3Client({
    region: "auto",
    endpoint: "https://" + account + ".r2.cloudflarestorage.com",
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    maxAttempts: 1,
  });
  try {
    const rows = await queryD1("SELECT id,publication_status,poster,backdrop,subtitle_url,cast_json,episodes_json,download_sources_json,streaming_sources_json,storage_key,r2_storage_key FROM movies");
    const referenced = new Set();
    for (const row of rows) {
      if (row.publication_status === "archived") continue;
      for (const key of movieKeys(row)) referenced.add(key);
    }
    const objects = await listAllObjects(client, bucket);
    const orphaned = objects.filter((object) => MAX_MANAGED_KEY.test(object.key) && !referenced.has(object.key));
    for (const object of orphaned) console.warn(JSON.stringify({ event: "r2_orphan_candidate", key: object.key, bytes: object.bytes }));
    const execute = process.argv.includes("--execute");
    if (!execute) {
      console.log(JSON.stringify({ event: "r2_cleanup_complete", mode: "dry-run", d1Movies: rows.length, r2Objects: objects.length, referenced: referenced.size, orphaned: orphaned.length, estimatedBytes: orphaned.reduce((total, object) => total + object.bytes, 0) }, null, 2));
      return;
    }
    let deleted = 0;
    let failed = 0;
    for (let offset = 0; offset < orphaned.length; offset += DELETE_BATCH_SIZE) {
      const batch = orphaned.slice(offset, offset + DELETE_BATCH_SIZE);
      try {
        const result = await sendWithRetry(client, new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch.map((object) => ({ Key: object.key })), Quiet: false } }));
        const errors = result.Errors || [];
        failed += errors.length;
        for (const error of errors) console.error(JSON.stringify({ event: "r2_orphan_delete_failed", key: error.Key, code: error.Code, message: error.Message }));
        deleted += batch.length - errors.length;
      } catch (error) {
        failed += batch.length;
        console.error(JSON.stringify({ event: "r2_orphan_delete_batch_failed", count: batch.length, error: String(error) }));
      }
    }
    console.log(JSON.stringify({ event: "r2_cleanup_complete", mode: "execute", d1Movies: rows.length, r2Objects: objects.length, referenced: referenced.size, orphaned: orphaned.length, deleted, failed }));
    if (failed) process.exitCode = 1;
  } finally {
    client.destroy();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ event: "r2_cleanup_fatal", error: String(error) }));
  process.exitCode = 1;
});
