import { S3Client, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const DEFAULT_DATABASE_ID = "a8e45cf6-effe-430f-9f7d-3ff85aea0acc";
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.R2_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
const d1Token = process.env.CLOUDFLARE_D1_TOKEN || process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID || process.env.D1_DATABASE_ID || process.env.CLOUDFLARE_DATABASE_ID || DEFAULT_DATABASE_ID;
const r2AccessKeyId = process.env.R2_ACCESS_KEY_ID;
const r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET_NAME || "flixlyra-media";
const siteOrigin = (process.env.PUBLIC_SITE_ORIGIN || "https://flixlyra.com").replace(/\/+$/, "");
const omdbApiKey = process.env.OMDB_API_KEY || "";
const tmdbApiToken = process.env.TMDB_API_TOKEN || "";
const tmdbApiKey = process.env.TMDB_API_KEY || "";
const ytsEndpoints = [
  "https://movies-api.accel.li/api/v2/movie_details.json",
  "https://yts.mx/api/v2/movie_details.json",
];
const maxImageBytes = 10 * 1024 * 1024;
const imageTimeoutMs = 10000;
const runExecute = process.argv.includes("--execute");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const requestTimeoutMs = 10000;
const maxRequestAttempts = 3;
async function fetchWithRetry(url, init = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxRequestAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('request timeout')), requestTimeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maxRequestAttempts) return response;
      await response.body?.cancel().catch(() => {});
      await sleep(response.status === 429 ? 2000 : 500 * 2 ** (attempt - 1));
    } catch (error) {
      lastError = error;
      if (attempt === maxRequestAttempts) throw error;
      await sleep(500 * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('request failed');
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value, maximum = 5000) {
  return typeof value === "string" ? value.normalize("NFKC").trim().slice(0, maximum) : "";
}

function safeError(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [d1Token, r2AccessKeyId, r2SecretAccessKey, omdbApiKey, tmdbApiToken, tmdbApiKey]) {
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  return message.replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]").slice(0, 300);
}

function validImdbId(value) {
  return /^tt[0-9]{7,10}$/.test(text(value, 16));
}

function invalidDirector(value) {
  const candidate = text(value, 160);
  return candidate.length < 3 || /^(?:pending editorial review|me|mee)$/i.test(candidate);
}

function validYoutubeUrl(value) {
  const candidate = text(value, 1000);
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    const allowed = host === "youtube.com" || host === "www.youtube.com" ||
      host === "m.youtube.com" || host === "youtube-nocookie.com" ||
      host === "www.youtube-nocookie.com" || host === "youtu.be";
    return url.protocol === "https:" && allowed &&
      ((host === "youtu.be" && url.pathname.length > 1) ||
        (host !== "youtu.be" && url.pathname === "/watch" && url.searchParams.has("v")));
  } catch {
    return false;
  }
}

function invalidArtworkValue(value) {
  const candidate = text(value, 1000);
  return !candidate || /(?:^|\/)(?:og|rsg|nss)\.png(?:$|[?#])/i.test(candidate) ||
    candidate.toLowerCase().includes("/media/movie-art/");
}

function allowedImageHost(hostname) {
  return ["image.tmdb.org", "m.media-amazon.com", "yts.mx", "yts.lt", "img.yts.mx"].includes(hostname.toLowerCase());
}

function sourceImage(value) {
  const candidate = text(value, 2000);
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && allowedImageHost(url.hostname)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function sourceImageCandidate(value) {
  return sourceImage(value);
}

function tmdbImage(path, size = "original") {
  const candidate = text(path, 1000);
  if (!candidate || !candidate.startsWith("/") || candidate.includes("..")) return null;
  return sourceImage("https://image.tmdb.org/t/p/" + size + candidate);
}

function publicArtworkUrl(id, kind) {
  return siteOrigin + "/media/artworks/" + Number(id) + "/" + kind + ".jpg";
}

function canonicalArtworkValue(value, id, kind) {
  const candidate = text(value, 2000);
  const path = "/media/artworks/" + Number(id) + "/" + kind + ".jpg";
  return candidate === path || candidate === siteOrigin + path;
}

function storedArtworkUrl(value) {
  const candidate = text(value, 2000);
  if (!candidate || invalidArtworkValue(candidate)) return null;
  if (candidate.startsWith("/")) return siteOrigin + candidate;
  try {
    const url = new URL(candidate);
    if (url.protocol === "https:" && url.origin === siteOrigin) return url.toString();
  } catch {
    return null;
  }
  return sourceImage(candidate);
}

async function readBoundedBody(response) {
  if (!response.body) throw new Error("IMAGE_EMPTY_BODY");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxImageBytes) {
        await reader.cancel();
        throw new Error("IMAGE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!total) throw new Error("IMAGE_EMPTY_BODY");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function verifyImageResponse(response) {
  if (response.status !== 200 || !response.body) {
    response.body?.cancel();
    return false;
  }
  const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (!contentType.startsWith("image/")) {
    response.body.cancel();
    return false;
  }
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxImageBytes) {
        await reader.cancel();
        return false;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return total > 0;
}

async function verifyStoredArtwork(value) {
  const url = storedArtworkUrl(value);
  if (!url) return false;
  try {
    const response = await fetchWithRetry(url, { redirect: "follow", signal: AbortSignal.timeout(imageTimeoutMs) });
    return await verifyImageResponse(response);
  } catch {
    return false;
  }
}

async function verifyPublicArtwork(url) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetchWithRetry(url, { redirect: "follow", signal: AbortSignal.timeout(imageTimeoutMs) });
      if (await verifyImageResponse(response)) return true;
    } catch {
      // Allow brief R2/CDN propagation delay.
    }
    if (attempt < 4) await sleep(1500);
  }
  return false;
}

async function downloadImage(value) {
  let current = sourceImage(value);
  if (!current) throw new Error("IMAGE_SOURCE_NOT_ALLOWED");
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetchWithRetry(current, { redirect: "manual", signal: AbortSignal.timeout(imageTimeoutMs) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === 3) throw new Error("IMAGE_TOO_MANY_REDIRECTS");
      const location = response.headers.get("location");
      response.body?.cancel();
      const next = location ? sourceImage(new URL(location, current).toString()) : null;
      if (!next) throw new Error("IMAGE_REDIRECT_NOT_ALLOWED");
      current = next;
      continue;
    }
    if (response.status !== 200 || !response.body) {
      response.body?.cancel();
      throw new Error("IMAGE_" + response.status);
    }
    const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (!contentType.startsWith("image/")) {
      response.body.cancel();
      throw new Error("IMAGE_CONTENT_TYPE_NOT_ALLOWED");
    }
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > maxImageBytes) {
      response.body.cancel();
      throw new Error("IMAGE_TOO_LARGE");
    }
    const bytes = await readBoundedBody(response);
    return { bytes, contentType, source: current };
  }
  throw new Error("IMAGE_REDIRECT_NOT_ALLOWED");
}

async function verifyYoutubeOembed(value) {
  if (!validYoutubeUrl(value)) return false;
  try {
    const endpoint = new URL("https://www.youtube.com/oembed");
    endpoint.searchParams.set("url", text(value, 1000));
    endpoint.searchParams.set("format", "json");
    const response = await fetchWithRetry(endpoint, { signal: AbortSignal.timeout(imageTimeoutMs) });
    if (response.status !== 200) return false;
    const payload = await response.json().catch(() => null);
    return isRecord(payload) && Boolean(text(payload.title, 300));
  } catch {
    return false;
  }
}

async function queryD1(sql, params = []) {
  const response = await fetchWithRetry("https://api.cloudflare.com/client/v4/accounts/" + accountId + "/d1/database/" + databaseId + "/query", {
    method: "POST",
    headers: { Authorization: "Bearer " + d1Token, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(60000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success || payload.result?.some((item) => item.success === false)) {
    throw new Error("D1 query failed (" + response.status + ")");
  }
  return payload.result.flatMap((item) => item.results || []);
}

function lookupTitle(row) {
  return text(row.title, 200).replace(/\s*[-_]\s*[0-9]{4}\s*$/, "").replace(/[-_]+/g, " ").trim();
}

async function resolveImdbId(row) {
  const knownFallbacks = { 7: "tt2025526" };
  const knownFallback = validImdbId(knownFallbacks[Number(row.id)]) ? knownFallbacks[Number(row.id)] : null;
  if (knownFallback && text(row.imdb_id, 16) !== knownFallback) {
    console.warn(JSON.stringify({ event: "imdb-resolution-fallback", id: row.id, title: lookupTitle(row), imdbId: knownFallback, reason: "curated-title-identity-fallback" }));
    return knownFallback;
  }
  if (validImdbId(row.imdb_id)) return text(row.imdb_id, 16);
  const title = lookupTitle(row);
  if (!title) {
    console.warn(JSON.stringify({ event: "imdb-resolution-failed", id: row.id, reason: "missing_title" }));
    return null;
  }
  if (omdbApiKey) {
    try {
      const params = new URLSearchParams({ t: title, apikey: omdbApiKey, plot: "short" });
      const response = await fetchWithRetry("https://www.omdbapi.com/?" + params, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(20000),
      });
      const payload = await response.json().catch(() => null);
      const candidate = text(payload?.imdbID, 16);
      if (response.ok && payload?.Response === "True" && validImdbId(candidate)) return candidate;
      console.warn(JSON.stringify({ event: "imdb-resolution-warning", id: row.id, source: "omdb", reason: text(payload?.Error, 180) || "title_not_found" }));
    } catch (error) {
      console.warn(JSON.stringify({ event: "imdb-resolution-warning", id: row.id, source: "omdb", error: safeError(error) }));
    }
  }
  if (tmdbApiKey || tmdbApiToken) {
    try {
      const searched = await tmdbRequest("/search/movie", { query: title, ...(Number(row.release_year) > 0 ? { year: String(row.release_year) } : {}), language: "en-US" });
      const tmdbId = searched?.results?.[0]?.id;
      if (tmdbId) {
        const external = await tmdbRequest("/movie/" + tmdbId + "/external_ids", {});
        const candidate = text(external?.imdb_id, 16);
        if (validImdbId(candidate)) return candidate;
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: "imdb-resolution-warning", id: row.id, source: "tmdb", error: safeError(error) }));
    }
  }
  console.warn(JSON.stringify({ event: "imdb-resolution-failed", id: row.id, title, reason: "no_valid_imdb_id_from_omdb_or_tmdb" }));
  return null;
}

async function ensureImdbId(row) {
  const resolved = await resolveImdbId(row);
  if (!resolved || resolved === text(row.imdb_id, 16)) return { ...row, imdb_id: resolved || row.imdb_id };
  await queryD1("UPDATE movies SET imdb_id = ? WHERE id = ?", [resolved, row.id]);
  console.log(JSON.stringify({ event: "imdb-id-resolved", id: row.id, imdbId: resolved }));
  return { ...row, imdb_id: resolved };
}

async function fetchYts(row) {
  if (!validImdbId(row.imdb_id)) { console.warn(JSON.stringify({ event: "provider-failure", id: row.id, reason: "missing_imdb_id", source: "yts" })); return null; }
  const query = new URLSearchParams({ imdb_id: row.imdb_id, with_images: "true", with_cast: "true" });
  let lastError;
  for (const endpoint of ytsEndpoints) {
    try {
      const response = await fetchWithRetry(endpoint + "?" + query, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error("YTS_" + response.status);
      const payload = await response.json();
      const movie = isRecord(payload?.data?.movie) ? payload.data.movie : null;
      if (movie) return movie;
      throw new Error("YTS_INVALID_RESPONSE");
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) console.warn(JSON.stringify({ event: "yts-warning", id: row.id, imdbId: row.imdb_id, error: safeError(lastError) }));
  return null;
}

async function fetchOmdb(row) {
  if (!omdbApiKey) return null;
  if (!validImdbId(row.imdb_id)) console.warn(JSON.stringify({ event: "provider-failure", id: row.id, reason: "missing_imdb_id_title_fallback", source: "omdb" }));
  const params = new URLSearchParams({ apikey: omdbApiKey, plot: "short" });
  if (validImdbId(row.imdb_id)) params.set("i", row.imdb_id);
  else {
    const title = lookupTitle(row);
    if (!title) return null;
    params.set("t", title);
    if (Number.isInteger(Number(row.release_year)) && Number(row.release_year) > 0) params.set("y", String(row.release_year));
  }
  try {
    const response = await fetchWithRetry("https://www.omdbapi.com/?" + params, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.Response !== "True") { console.warn(JSON.stringify({ event: "provider-failure", id: row.id, reason: response.status === 429 ? "omdb_429_rate_limit" : "omdb_response_unresolved", detail: text(payload?.Error, 180), source: "omdb" })); return null; }
    if (validImdbId(row.imdb_id) && payload.imdbID && payload.imdbID !== row.imdb_id) return null;
    const cast = text(payload.Actors, 1000).split(",").map((name) => text(name, 120)).filter(Boolean).slice(0, 6);
    return {
      provider: "omdb",
      poster: sourceImageCandidate(payload.Poster),
      backdrop: null,
      director: text(payload.Director, 160).replace(/^N\/A$/i, ""),
      cast,
      trailer: null,
    };
  } catch (error) {
    console.warn(JSON.stringify({ event: "omdb-warning", id: row.id, error: safeError(error) }));
    return null;
  }
}

async function tmdbRequest(path, params = {}) {
  const query = new URLSearchParams(params);
  const headers = { accept: "application/json" };
  if (tmdbApiToken) headers.Authorization = "Bearer " + tmdbApiToken;
  else query.set("api_key", tmdbApiKey);
  const response = await fetchWithRetry("https://api.themoviedb.org/3" + path + "?" + query, {
    headers,
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(response.status === 429 ? "TMDB_429_RATE_LIMIT" : "TMDB_" + response.status);
  return response.json();
}

async function fetchTmdb(row) {
  if (!tmdbApiToken && !tmdbApiKey) return null;
  try {
    const imdbIds = row.id === 10
      ? [...new Set([text(row.imdb_id, 16), "tt0499549"].filter(validImdbId))]
      : (validImdbId(row.imdb_id) ? [text(row.imdb_id, 16)] : []);
    let selected = null;
    for (const imdbId of imdbIds) {
      const found = await tmdbRequest("/find/" + encodeURIComponent(imdbId), { external_source: "imdb_id", language: "en-US" });
      const result = found?.movie_results?.[0] || null;
      if (!result?.id) {
        console.warn(JSON.stringify({ event: "provider-failure", id: row.id, imdbId, reason: "tmdb_movie_results_empty", source: "tmdb" }));
        continue;
      }
      if (!result.backdrop_path) console.warn(JSON.stringify({ event: "provider-failure", id: row.id, imdbId, reason: "tmdb_backdrop_path_null", source: "tmdb" }));
      const videosPayload = await tmdbRequest("/movie/" + result.id + "/videos", { language: "en-US" });
      const videos = (videosPayload?.results || []).filter((video) => video.site === "YouTube" && /^[A-Za-z0-9_-]{11}$/.test(text(video.key, 32)));
      const trailer = videos.find((video) => video.type === "Trailer" && video.official === true) ||
        videos.find((video) => video.type === "Trailer") ||
        videos.find((video) => video.type === "Teaser" && video.official === true) ||
        videos.find((video) => video.type === "Teaser") ||
        videos.find((video) => video.type === "Clip" && video.official === true) ||
        videos.find((video) => video.type === "Clip");
      const score = (result.poster_path ? 1 : 0) + (result.backdrop_path ? 1 : 0) + (trailer ? 4 : 0);
      if (!selected || score > selected.score) selected = { imdbId, result, trailer, score };
      if (trailer && result.poster_path && result.backdrop_path) break;
    }
    if (!selected) {
      console.warn(JSON.stringify({ event: "provider-failure", id: row.id, reason: "tmdb_movie_results_empty", source: "tmdb" }));
      return null;
    }
    const { result, trailer } = selected;
    if (!trailer) console.warn(JSON.stringify({ event: "provider-failure", id: row.id, reason: "tmdb_no_youtube_trailer_after_type_fallback", source: "tmdb" }));
    let director = "";
    let cast = [];
    try {
      const credits = await tmdbRequest("/movie/" + result.id + "/credits", { language: "en-US" });
      director = (credits?.crew || []).filter((person) => person.job === "Director").map((person) => text(person.name, 160)).filter(Boolean).join(", ");
      cast = (credits?.cast || []).map((person) => ({ name: text(person.name, 120), character: text(person.character, 120), profile_url: person.profile_path ? "https://image.tmdb.org/t/p/w185" + text(person.profile_path, 160) : null })).filter((person) => person.name).slice(0, 6);
    } catch (error) {
      console.warn(JSON.stringify({ event: "tmdb-credits-warning", id: row.id, error: safeError(error) }));
    }
    return { provider: "tmdb", poster: tmdbImage(result.poster_path), backdrop: tmdbImage(result.backdrop_path), director, cast, trailer: trailer ? "https://www.youtube.com/watch?v=" + text(trailer.key, 32) : null };
  } catch (error) {
    console.warn(JSON.stringify({ event: "tmdb-warning", id: row.id, error: safeError(error) }));
    return null;
  }
}

function ytsImageSources(movie, kind) {
  if (!isRecord(movie)) return [];
  const fields = kind === "poster"
    ? ["large_cover_image", "medium_cover_image", "background_image", "background_image_original"]
    : ["background_image_original", "background_image", "large_cover_image", "medium_cover_image"];
  return [...new Set(fields.map((field) => sourceImageCandidate(movie[field])).filter(Boolean))];
}

function providerImageSources(provider, kind) {
  if (!provider) return [];
  const values = kind === "poster"
    ? [provider.poster]
    : [provider.backdrop, provider.poster];
  return values.map((value) => sourceImageCandidate(value)).filter(Boolean);
}

async function repairArtwork(s3, row, kind, yts, providers) {
  const sources = [
    ...ytsImageSources(yts, kind),
    ...providers.flatMap((provider) => providerImageSources(provider, kind)),
  ];
  const uniqueSources = [...new Set(sources)];
  if (!uniqueSources.length) {
    console.warn(JSON.stringify({ event: "artwork-unresolved", id: row.id, imdbId: row.imdb_id, kind, reason: "no-candidate-sources" }));
    return null;
  }
  let lastError;
  for (const source of uniqueSources) {
    try {
      const downloaded = await downloadImage(source);
      const keyUrl = publicArtworkUrl(row.id, kind);
      if (!runExecute) return keyUrl;
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: "artworks/" + Number(row.id) + "/" + kind + ".jpg",
        Body: downloaded.bytes,
        ContentType: downloaded.contentType,
        CacheControl: "public, max-age=31536000, immutable",
        Metadata: { source: downloaded.source, movieId: String(row.id), kind },
      }));
      const verified = await s3.send(new HeadObjectCommand({
        Bucket: bucket,
        Key: "artworks/" + Number(row.id) + "/" + kind + ".jpg",
      }));
      if (!verified.ContentLength || Number(verified.ContentLength) !== downloaded.bytes.byteLength) {
        throw new Error("R2_ARTWORK_VERIFY_FAILED");
      }
      if (!(await verifyPublicArtwork(keyUrl))) throw new Error("PUBLIC_ARTWORK_HTTP_VERIFY_FAILED");
      return keyUrl;
    } catch (error) {
      lastError = error;
    }
  }
  console.warn(JSON.stringify({
    event: "artwork-unresolved",
    id: row.id,
    imdbId: row.imdb_id,
    kind,
    reason: safeError(lastError || new Error("all-candidates-failed")),
    candidates: uniqueSources.length,
  }));
  return null;
}

function metadataCast(value) {
  if (Array.isArray(value)) {
    return value.slice(0, 6).flatMap((entry) => {
      if (typeof entry === "string") {
        const actor = text(entry, 120);
        return actor ? [actor] : [];
      }
      if (!isRecord(entry)) return [];
      const name = text(entry.name || entry.actor, 120);
      if (!name) return [];
      const character = text(entry.character || entry.character_name, 120);
      const profile = sourceImageCandidate(entry.profile_url || entry.profileUrl);
      const image = sourceImageCandidate(entry.image);
      return [{ name, ...(character ? { character } : {}), ...(profile ? { profile_url: profile } : {}), ...(image ? { image } : {}) }];
    });
  }
  if (typeof value === "string") {
    try { return metadataCast(JSON.parse(value)); } catch { return []; }
  }
  return [];
}

function ytsDirector(movie) {
  return isRecord(movie) ? text(movie.director, 160) : "";
}

function ytsCast(movie) {
  return isRecord(movie) ? metadataCast(movie.cast) : [];
}

function castNeedsProfile(value) {
  const cast = metadataCast(value);
  return !cast.length || cast.some((member) => !member.profile_url);
}

function ytsTrailer(movie) {
  if (!isRecord(movie)) return null;
  const code = text(movie.yt_trailer_code, 32);
  return /^[A-Za-z0-9_-]{11}$/.test(code) ? "https://www.youtube.com/watch?v=" + code : null;
}

async function resetTransferLocks() {
  const locks = await queryD1(
    "SELECT id FROM movies WHERE id = 25 OR transfer_token IS NOT NULL OR (transfer_lease_until IS NOT NULL AND transfer_lease_until < unixepoch())",
  );
  if (locks.length) {
    await queryD1(
      "UPDATE movies SET transfer_token = NULL, transfer_lease_until = NULL, transfer_error = NULL WHERE id = 25 OR transfer_token IS NOT NULL OR (transfer_lease_until IS NOT NULL AND transfer_lease_until < unixepoch())",
    );
  }
  console.log(JSON.stringify({
    event: "transfer-locks-reset",
    count: locks.length,
    ids: locks.map((row) => row.id),
    schema: "transfer_token/transfer_lease_until",
  }));
}

async function releaseLocksBestEffort() {
  if (!accountId || !d1Token) return;
  try { await resetTransferLocks(); }
  catch (error) { console.error(JSON.stringify({ event: 'transfer-lock-release-failed', error: safeError(error) })); }
}
let shutdownStarted = false;
async function handleShutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.warn(JSON.stringify({ event: 'shutdown-requested', signal }));
  await releaseLocksBestEffort();
  process.exitCode = 1;
  process.exit();
}
process.once('SIGINT', () => { void handleShutdown('SIGINT'); });
process.once('SIGTERM', () => { void handleShutdown('SIGTERM'); });
async function providerMetadata(row, yts, needsProvider) {
  if (!needsProvider) return [];
  const providers = [];
  const omdb = await fetchOmdb(row);
  if (omdb) providers.push(omdb);
  const tmdb = await fetchTmdb(row);
  if (tmdb) providers.push(tmdb);
  if (!providers.length) {
    console.warn(JSON.stringify({
      event: "metadata-provider-unavailable",
      id: row.id,
      imdbId: row.imdb_id,
      configured: { omdb: Boolean(omdbApiKey), tmdb: Boolean(tmdbApiToken || tmdbApiKey) },
    }));
  }
  return providers;
}

async function markMovieFlagged(id, reason) {
  const message = text(reason, 1000) || 'movie item requires manual review';
  try {
    await queryD1("UPDATE movies SET ingest_status = 'flagged_for_review', transfer_error = ?, transfer_token = NULL, transfer_lease_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND (ingest_status IS NOT 'flagged_for_review' OR transfer_error IS NOT ?)", [message, id, message]);
  } catch (error) {
    console.error(JSON.stringify({ event: 'movie-flag-update-failed', id, error: safeError(error) }));
  }
}
async function processRow(s3, row) {
  const posterOk = !invalidArtworkValue(row.poster) && canonicalArtworkValue(row.poster, row.id, "poster") && await verifyPublicArtwork(publicArtworkUrl(row.id, "poster"));
  const backdropOk = !invalidArtworkValue(row.backdrop) && canonicalArtworkValue(row.backdrop, row.id, "backdrop") && await verifyPublicArtwork(publicArtworkUrl(row.id, "backdrop"));
  const trailerOk = await verifyYoutubeOembed(row.official_watch_url);
  if (posterOk && backdropOk && !invalidDirector(row.director) && trailerOk && !castNeedsProfile(row.cast_json)) return { id: row.id, updates: {}, unresolved: [], reasons: [] };

  const reasons = [];
  const yts = await fetchYts(row);
  const providers = await providerMetadata(row, yts, true);
  const poster = posterOk ? text(row.poster) : await repairArtwork(s3, row, "poster", yts, providers);
  const backdrop = backdropOk ? text(row.backdrop) : await repairArtwork(s3, row, "backdrop", yts, providers);
  const director = invalidDirector(row.director)
    ? [ytsDirector(yts), ...providers.map((provider) => provider.director)].find((value) => !invalidDirector(value)) || null
    : text(row.director, 160);
  let trailer = trailerOk ? text(row.official_watch_url) : null;
  if (!trailer) {
    for (const candidate of [ytsTrailer(yts), ...providers.map((provider) => provider.trailer)].filter(Boolean)) {
      if (await verifyYoutubeOembed(candidate)) { trailer = candidate; break; }
    }
  }
  const currentCast = metadataCast(row.cast_json);
  const providerCast = [ytsCast(yts), ...providers.map((provider) => metadataCast(provider.cast))].flat().filter(Boolean);
  const profiledProviderCast = providerCast.filter((member) => isRecord(member) && member.profile_url);
  const cast = (profiledProviderCast.length ? profiledProviderCast : (currentCast.length ? currentCast : providerCast)).slice(0, 6);
  const updates = {
    director: director || null,
    cast_json: cast.length ? JSON.stringify(cast) : text(row.cast_json) || null,
    official_watch_url: trailer || null,
    poster: poster || null,
    backdrop: backdrop || null,
  };
  const unresolved = [];
  if (!updates.poster || !(await verifyPublicArtwork(publicArtworkUrl(row.id, "poster")))) unresolved.push("poster");
  if (!updates.backdrop || !(await verifyPublicArtwork(publicArtworkUrl(row.id, "backdrop")))) unresolved.push("backdrop");
  if (invalidDirector(updates.director)) unresolved.push("director");
  if (!trailer) unresolved.push("official_watch_url");
  if (!poster) reasons.push("poster_unresolved");
  if (!backdrop) reasons.push("backdrop_unresolved");
  if (!director) reasons.push("director_unresolved");
  if (!trailer) reasons.push("trailer_unresolved");

  if (runExecute && unresolved.length === 0) {
    await queryD1(
      "UPDATE movies SET director = ?, cast_json = ?, official_watch_url = ?, poster = ?, backdrop = ? WHERE id = ? AND (director IS NOT ? OR cast_json IS NOT ? OR official_watch_url IS NOT ? OR poster IS NOT ? OR backdrop IS NOT ?)",
      [updates.director, updates.cast_json, updates.official_watch_url, updates.poster, updates.backdrop, row.id, updates.director, updates.cast_json, updates.official_watch_url, updates.poster, updates.backdrop],
    );
  } else if (runExecute && unresolved.length) {
    await markMovieFlagged(row.id, unresolved.join(', '));
    console.warn(JSON.stringify({ event: "d1-update-skipped", id: row.id, unresolved, reason: "required-fields-unresolved" }));
  }
  console.log(JSON.stringify({
    event: unresolved.length ? "movie-backfill-failed" : (runExecute ? "backfill-update" : "backfill-plan"),
    id: row.id,
    imdbId: row.imdb_id,
    fields: Object.keys(updates),
    unresolved,
    reasons,
  }));
  return { id: row.id, updates, unresolved, reasons };
}

async function auditAllMovies(rows) {
  const audit = [];
  for (const row of rows) {
    const failures = [];
    if (invalidDirector(row.director)) failures.push("director");
    for (const kind of ["poster", "backdrop"]) {
      const valid = !invalidArtworkValue(row[kind]) && canonicalArtworkValue(row[kind], row.id, kind) && await verifyPublicArtwork(publicArtworkUrl(row.id, kind));
      if (!valid) failures.push(kind);
    }
    if (!(await verifyYoutubeOembed(row.official_watch_url))) failures.push("official_watch_url");
    audit.push({ id: row.id, title: text(row.title, 45), director: !invalidDirector(row.director), poster: !failures.includes("poster"), backdrop: !failures.includes("backdrop"), trailer: !failures.includes("official_watch_url"), failures: failures.join(",") });
  }
  console.table(audit);
  return audit;
}

async function main() {
  let s3 = null;
  try {
  if (!accountId || !d1Token) throw new Error("Cloudflare account ID and D1 API token are required");
  await resetTransferLocks();
  if (!omdbApiKey || (!tmdbApiKey && !tmdbApiToken)) {
    console.error(JSON.stringify({ event: "credential-guard-failed", required: ["OMDB_API_KEY", "TMDB_API_KEY or TMDB_API_TOKEN"] }));
    process.exit(1);
  }
  if (runExecute && (!r2AccessKeyId || !r2SecretAccessKey)) throw new Error("R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required for --execute");
  const rows = await queryD1("SELECT id, title, release_year, imdb_id, poster, backdrop, director, cast_json, official_watch_url FROM movies ORDER BY id");
  s3 = runExecute ? new S3Client({
    region: "auto",
    endpoint: "https://" + accountId + ".r2.cloudflarestorage.com",
    maxAttempts: 3,
    credentials: { accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey },
  }) : null;
  const results = [];
  for (const row of rows) {
    try {
      const preparedRow = await ensureImdbId(row);
      results.push(await processRow(s3, preparedRow));
    } catch (error) {
      const failure = { id: row.id, updates: {}, unresolved: ["row-error"], reasons: [safeError(error)] };
      results.push(failure);
      await markMovieFlagged(row.id, failure.reasons.join('; '));
      console.warn(JSON.stringify({ event: "movie-backfill-failed", id: row.id, reasons: failure.reasons }));
    }
  }
  const refreshedRows = await queryD1("SELECT id, title, imdb_id, poster, backdrop, director, cast_json, official_watch_url FROM movies ORDER BY id");
  const audit = await auditAllMovies(refreshedRows);
  const unresolved = results.filter((result) => result.unresolved.length);
  const auditFailures = audit.filter((result) => result.failures);
  console.log(JSON.stringify({
    event: "force-backfill-complete",
    mode: runExecute ? "execute" : "dry-run",
    totalMovies: rows.length,
    rowsWithChanges: results.filter((result) => Object.keys(result.updates).length).length,
    unresolvedMovies: unresolved.length,
    postAuditFailures: auditFailures.length,
    unresolved: unresolved.map((result) => ({ id: result.id, fields: result.unresolved, reasons: result.reasons })),
  }));
  console.log(JSON.stringify({ event: 'item-failures-nonfatal', unresolvedMovies: unresolved.length, postAuditFailures: auditFailures.length }));
  } finally {
    s3?.destroy();
    await releaseLocksBestEffort();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ event: "force-backfill-fatal", error: safeError(error) }));
  process.exitCode = 1;
});