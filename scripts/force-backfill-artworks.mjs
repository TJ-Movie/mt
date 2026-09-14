import { S3Client, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const DEFAULT_DATABASE_ID = "a8e45cf6-effe-430f-9f7d-3ff85aea0acc";
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.R2_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
const d1Token = process.env.CLOUDFLARE_D1_TOKEN || process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID || process.env.D1_DATABASE_ID || process.env.CLOUDFLARE_DATABASE_ID || DEFAULT_DATABASE_ID;
const r2AccessKeyId = process.env.R2_ACCESS_KEY_ID;
const r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET_NAME || "flixlyra-media";
const siteOrigin = (process.env.PUBLIC_SITE_ORIGIN || "https://flixlyra.com").replace(/\/+$/, "");
const publicBase = (process.env.R2_PUBLIC_BASE_URL || siteOrigin + "/media").replace(/\/+$/, "");
const omdbApiKey = process.env.OMDB_API_KEY || process.env.OMDB_API_TOKEN || "";
const tmdbApiToken = process.env.TMDB_API_TOKEN || process.env.TMDB_READ_ACCESS_TOKEN || "";
const tmdbApiKey = process.env.TMDB_API_KEY || "";
const ytsEndpoints = [
  "https://movies-api.accel.li/api/v2/movie_details.json",
  "https://yts.mx/api/v2/movie_details.json",
];
const maxImageBytes = 10 * 1024 * 1024;
const runExecute = process.argv.includes("--execute");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    candidate.includes("/media/movie-art/");
}

function allowedImageHost(hostname) {
  const host = hostname.toLowerCase();
  return host === "image.tmdb.org" ||
    host === "m.media-amazon.com" || host.endsWith(".m.media-amazon.com") ||
    host === "images.metahub.space" ||
    host === "yts.gg" || host.endsWith(".yts.gg") ||
    host === "yts.mx" || host.endsWith(".yts.mx") ||
    host === "yts.lt" || host.endsWith(".yts.lt") ||
    host === "yts.am" || host.endsWith(".yts.am") ||
    host === "yts.rs" || host.endsWith(".yts.rs") ||
    host === "yts.pm" || host.endsWith(".yts.pm");
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
  return publicBase + "/artworks/" + Number(id) + "/" + kind + ".jpg";
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

async function verifyImageResponse(response) {
  if (!response.ok || response.status !== 200 || !response.body) {
    response.body?.cancel();
    return false;
  }
  const contentType = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
  const valid = ["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(contentType);
  response.body.cancel();
  return valid;
}

async function verifyStoredArtwork(value) {
  const url = storedArtworkUrl(value);
  if (!url) return false;
  try {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20000) });
    return await verifyImageResponse(response);
  } catch {
    return false;
  }
}

async function verifyPublicArtwork(url) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20000) });
      if (await verifyImageResponse(response)) return true;
    } catch {
      // R2-backed public routes can need a short propagation retry.
    }
    if (attempt < 4) await sleep(1500);
  }
  return false;
}

async function downloadImage(value) {
  const source = sourceImage(value);
  if (!source) throw new Error("IMAGE_SOURCE_NOT_ALLOWED");
  const response = await fetch(source, { redirect: "follow", signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.body) throw new Error("IMAGE_" + response.status);
  const finalSource = sourceImage(response.url);
  if (!finalSource) throw new Error("IMAGE_REDIRECT_NOT_ALLOWED");
  const contentType = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
  if (!["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(contentType)) {
    throw new Error("IMAGE_CONTENT_TYPE_NOT_ALLOWED");
  }
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxImageBytes) throw new Error("IMAGE_TOO_LARGE");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.byteLength > maxImageBytes) throw new Error("IMAGE_EMPTY_OR_TOO_LARGE");
  return { bytes, contentType, source: finalSource };
}

async function queryD1(sql, params = []) {
  const response = await fetch("https://api.cloudflare.com/client/v4/accounts/" + accountId + "/d1/database/" + databaseId + "/query", {
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

async function fetchYts(row) {
  if (!validImdbId(row.imdb_id)) return null;
  const query = new URLSearchParams({ imdb_id: row.imdb_id, with_images: "true", with_cast: "true" });
  let lastError;
  for (const endpoint of ytsEndpoints) {
    try {
      const response = await fetch(endpoint + "?" + query, {
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
  const params = new URLSearchParams({ apikey: omdbApiKey, plot: "short" });
  if (validImdbId(row.imdb_id)) params.set("i", row.imdb_id);
  else {
    const title = lookupTitle(row);
    if (!title) return null;
    params.set("t", title);
    if (Number.isInteger(Number(row.release_year)) && Number(row.release_year) > 0) params.set("y", String(row.release_year));
  }
  try {
    const response = await fetch("https://www.omdbapi.com/?" + params, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.Response !== "True") return null;
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
  const response = await fetch("https://api.themoviedb.org/3" + path + "?" + query, {
    headers,
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error("TMDB_" + response.status);
  return response.json();
}

async function fetchTmdb(row) {
  if (!tmdbApiToken && !tmdbApiKey) return null;
  try {
    let result = null;
    if (validImdbId(row.imdb_id)) {
      const found = await tmdbRequest("/find/" + encodeURIComponent(row.imdb_id), {
        external_source: "imdb_id",
        language: "en-US",
      });
      result = found?.movie_results?.[0] || null;
    }
    if (!result) {
      const title = lookupTitle(row);
      if (!title) return null;
      const found = await tmdbRequest("/search/movie", {
        query: title,
        include_adult: "false",
        language: "en-US",
        ...(Number(row.release_year) > 0 ? { year: String(row.release_year) } : {}),
      });
      result = found?.results?.[0] || null;
    }
    if (!result?.id) return null;
    const detail = await tmdbRequest("/movie/" + result.id, {
      append_to_response: "credits,videos",
      language: "en-US",
    });
    const director = (detail.credits?.crew || []).find((person) => person.job === "Director")?.name || "";
    const cast = (detail.credits?.cast || []).slice(0, 6).map((person) => {
      const actor = text(person.name, 120);
      if (!actor) return null;
      const character = text(person.character, 120);
      const image = tmdbImage(person.profile_path, "w185");
      return { actor, ...(character ? { character } : {}), ...(image ? { image } : {}) };
    }).filter(Boolean);
    const videos = (detail.videos?.results || []).filter((video) =>
      video.site === "YouTube" && /^[A-Za-z0-9_-]{11}$/.test(text(video.key, 32)));
    const trailer = videos.find((video) => video.type === "Trailer" && video.official !== false) ||
      videos.find((video) => video.type === "Trailer") || videos[0];
    return {
      provider: "tmdb",
      poster: tmdbImage(detail.poster_path),
      backdrop: tmdbImage(detail.backdrop_path),
      director: text(director, 160),
      cast,
      trailer: trailer ? "https://www.youtube.com/watch?v=" + text(trailer.key, 32) : null,
    };
  } catch (error) {
    console.warn(JSON.stringify({ event: "tmdb-warning", id: row.id, error: safeError(error) }));
    return null;
  }
}

function ytsImageSources(movie) {
  if (!isRecord(movie)) return [];
  const fields = [
    "large_cover_image", "medium_cover_image",
    "background_image", "background_image_original",
    "poster_url", "poster", "tmdb_poster_url", "tmdb_poster_path",
    "backdrop_url", "backdrop", "tmdb_backdrop_url", "tmdb_backdrop_path",
    "imdb_poster_url", "imdb_backdrop_url",
  ];
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
    ...ytsImageSources(yts),
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
      const actor = text(entry.actor || entry.name, 120);
      if (!actor) return [];
      const character = text(entry.character || entry.character_name, 120);
      const image = sourceImageCandidate(entry.image);
      return [{ actor, ...(character ? { character } : {}), ...(image ? { image } : {}) }];
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

async function processRow(s3, row) {
  const posterOk = await verifyStoredArtwork(row.poster);
  const backdropOk = await verifyStoredArtwork(row.backdrop);
  const needsProvider = !posterOk || !backdropOk || invalidDirector(row.director) || !validYoutubeUrl(row.official_watch_url);
  const yts = await fetchYts(row);
  const providers = await providerMetadata(row, yts, needsProvider);
  const updates = {};
  let poster = row.poster;
  let backdrop = row.backdrop;
  if (!posterOk) {
    poster = await repairArtwork(s3, row, "poster", yts, providers);
    if (poster) updates.poster = poster;
  }
  if (!backdropOk) {
    backdrop = await repairArtwork(s3, row, "backdrop", yts, providers);
    if (backdrop) updates.backdrop = backdrop;
  }

  if (invalidDirector(row.director)) {
    const candidates = [ytsDirector(yts), ...providers.map((provider) => provider.director)];
    const director = candidates.find((candidate) => !invalidDirector(candidate));
    if (director) updates.director = director;
  }
  if (!validYoutubeUrl(row.official_watch_url)) {
    const trailer = ytsTrailer(yts) || providers.map((provider) => provider.trailer).find(validYoutubeUrl);
    if (trailer) updates.official_watch_url = trailer;
  }
  if (!metadataCast(row.cast_json).length) {
    const ytsCastValues = ytsCast(yts);
    const cast = ytsCastValues.length ? ytsCastValues : providers.flatMap((provider) => metadataCast(provider.cast));
    if (cast.length) updates.cast_json = JSON.stringify(cast);
  }

  const fields = Object.entries(updates);
  if (fields.length) {
    console.log(JSON.stringify({
      event: runExecute ? "backfill-update" : "backfill-plan",
      id: row.id,
      imdbId: row.imdb_id,
      fields: fields.map(([field]) => field),
    }));
    if (runExecute) {
      await queryD1(
        "UPDATE movies SET " + fields.map(([field]) => field + " = ?").join(", ") +
        ", revision = revision + 1, updated_at = ? WHERE id = ?",
        [...fields.map(([, value]) => value), new Date().toISOString(), row.id],
      );
    }
  }

  const finalPoster = updates.poster || row.poster;
  const finalBackdrop = updates.backdrop || row.backdrop;
  const finalDirector = updates.director || row.director;
  const finalTrailer = updates.official_watch_url || row.official_watch_url;
  const unresolved = [];
  if (!(updates.poster ? await verifyPublicArtwork(updates.poster) : posterOk)) unresolved.push("poster");
  if (!(updates.backdrop ? await verifyPublicArtwork(updates.backdrop) : backdropOk)) unresolved.push("backdrop");
  if (invalidDirector(finalDirector)) unresolved.push("director");
  if (!validYoutubeUrl(finalTrailer)) unresolved.push("youtube");
  return { id: row.id, updates, unresolved, finalPoster, finalBackdrop, finalDirector, finalTrailer };
}

async function main() {
  if (!accountId || !d1Token) throw new Error("Cloudflare account ID and D1 API token are required");
  if (runExecute && (!r2AccessKeyId || !r2SecretAccessKey)) {
    throw new Error("R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required for --execute");
  }

  await resetTransferLocks();
  const rows = await queryD1(
    "SELECT id, title, release_year, imdb_id, poster, backdrop, director, cast_json, official_watch_url FROM movies ORDER BY id",
  );
  const s3 = runExecute ? new S3Client({
    region: "auto",
    endpoint: "https://" + accountId + ".r2.cloudflarestorage.com",
    maxAttempts: 3,
    credentials: { accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey },
  }) : null;
  const results = [];
  for (const row of rows) {
    try {
      results.push(await processRow(s3, row));
    } catch (error) {
      results.push({ id: row.id, updates: {}, unresolved: ["row-error"], error: safeError(error) });
      console.warn(JSON.stringify({ event: "backfill-row-failed", id: row.id, error: safeError(error) }));
    }
  }
  s3?.destroy();
  const unresolved = results.filter((result) => result.unresolved.length > 0);
  const summary = {
    event: "force-backfill-complete",
    mode: runExecute ? "execute" : "dry-run",
    totalMovies: rows.length,
    rowsWithChanges: results.filter((result) => Object.keys(result.updates).length > 0).length,
    unresolvedMovies: unresolved.length,
    unresolved: unresolved.map((result) => ({ id: result.id, fields: result.unresolved, error: result.error })),
  };
  console.log(JSON.stringify(summary));
  if (unresolved.length) {
    throw new Error("STRICT_BACKFILL_UNRESOLVED: " + JSON.stringify(summary.unresolved));
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ event: "force-backfill-fatal", error: safeError(error) }));
  process.exitCode = 1;
});