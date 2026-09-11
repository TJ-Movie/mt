# Private video transfer runner

## GitHub Actions

The workflow runs from `workflow_dispatch`, `repository_dispatch`, and a daily `schedule` at 02:17 UTC (07:47 Sri Lanka). Each run first backfills both 720p and 1080p YTS descriptors for up to 20 draft records, then transfers each missing quality sequentially to R2. A movie is marked ready only after both quality entries have verified R2 keys.

Initial catalogue-fill mode has no three-films-per-day limit. Each run considers up to 20 queued records and only claims another film when enough run time remains. Runs are serialized with `cancel-in-progress: false`, so schedules do not interrupt active uploads. GitHub may delay scheduled runs; this is not a guaranteed start time. No workflow is triggered by pull requests, and manual runs on non-default branches are skipped. Dispatch payloads cannot change commands or resource limits.

Add repository Actions secrets: `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, and `SUBLYRA_ADMIN_URL`. Also add **`CLOUDFLARE_API_TOKEN`** with D1 edit permission on this account: R2 S3 credentials cannot read/update D1. The account secret maps to `R2_ACCOUNT_ID` for the runner and must match `wrangler.json`. `SUBLYRA_ADMIN_URL` is passed for compatibility but is not used by the direct-D1 runner; it is not an authentication credential. No admin cookies or interactive Access login are needed in CI.

CI handles up to 20 movie records sequentially within its run budget, with a 4 GiB whole-torrent cap and 2 GiB free-disk reserve. This is not a promise of 20 completions per run: slow torrents can consume the budget sooner. Each quality selects only the main MP4. Two cached pieces (each capped at 16 MiB) plus two 8 MiB multipart buffers bound these buffer pools, not the entire process. Torrent traffic is capped at 8 MiB/s download and 512 KiB/s peer upload, with 30 connections. R2 multipart upload is backpressured and is not capped by the peer-upload setting.

Each transfer gets 40 minutes; the process stops claiming work before its 150-minute budget. An outer 155-minute timeout sends SIGTERM with two minutes for cleanup; the transfer step and job have 160/180-minute limits. Slow/unseeded torrents can still fail; this is bounded execution, not a completion guarantee. Failed transfers retain a D1 error and need explicit requeueing. Interrupted leases expire for recovery. Unclaimed records remain queued for the next dispatch/hourly run. Cancellation/crash does not preserve torrent pieces between runners; use the bucket's incomplete multipart lifecycle cleanup as documented below.

The workflow never caches or uploads media, temp data, secrets or Wrangler logs as artifacts; only npm's package cache is reused. Action dependencies are commit-pinned and credentials exist only in the transfer step. Keep the default branch protected. Existing WebTorrent dependency warnings still apply. This remains MP4 transfer, not a disk-free transcoder.

Trigger semantics: [GitHub Actions events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows). CI token configuration: [Wrangler environment variables](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/).

Run from this checkout on an always-on Node 22+ computer or VPS. BitTorrent runs in this process, not a Cloudflare Worker. WebTorrent temporarily caches pieces on disk; provision free disk space at least equal to the largest movie (20 GiB limit by default). Upload uses two 8 MiB multipart buffers and streams the primary MP4; it never buffers the full movie in RAM.

## Credentials (never commit or paste them into chat)

Create R2 S3 credentials restricted to `flixlyra-media`. Supply these environment variables to the runner through your host's secret manager or a local ignored `.env.pipeline` file:

```
R2_ACCOUNT_ID=f0441748220f3ff9c6190e76209f31af
R2_BUCKET_NAME=flixlyra-media
R2_ACCESS_KEY_ID=your-object-read-write-access-key
R2_SECRET_ACCESS_KEY=your-object-read-write-secret
```

D1 uses the existing Wrangler login (`wrangler login`), or `CLOUDFLARE_API_TOKEN` with D1 edit permission. A persistent server should use an API token. Run from the repository root.

Configure **read-only** R2 credentials on the deployed Worker with interactive prompts:

```
npm exec wrangler -- secret put R2_ACCESS_KEY_ID --config wrangler.json
npm exec wrangler -- secret put R2_SECRET_ACCESS_KEY --config wrangler.json
```

The public bucket must remain disabled. Signed links are bearer links valid for 120 seconds; anyone receiving a link can use it during that window. Rights revocation prevents new links, not an already-issued link until it expires.

## Run

```
npm run db:migrate
node --env-file=.env.pipeline scripts/magnet-to-r2.mjs
node --env-file=.env.pipeline scripts/magnet-to-r2.mjs --watch
```

Outside CI, one-shot mode defaults to up to 20 queued records sequentially; watch mode polls every 30 seconds. Use a service manager for unattended restarts. The default transfer deadline is three hours, with a lease ten minutes longer; the default process budget is 24 hours. `TRANSFER_BATCH_SIZE`, `TRANSFER_TIMEOUT_SECONDS` and `TRANSFER_RUN_SECONDS` override these with validated limits. Failed jobs are not endlessly retried. Inspect `transfer_error`, correct the cause, then explicitly requeue the affected ID. Crashed leases become eligible after expiry. Abrupt power loss may leave temporary files or unfinished multipart uploads; configure an R2 incomplete-upload lifecycle rule and host temp cleanup.

Sources: normalized BTIH magnets in `download_sources_json`, the private torrent descriptor in `storage_key` populated by YTS ingestion, or HTTPS torrent URLs on `TORRENT_SOURCE_HOSTS` (comma-separated exact hostnames; defaults to `yts.gg`). Descriptor fetching rejects redirects and limits payloads to 2 MiB. Only allow trusted public source hosts. Descriptor and video keys are distinct; the video key is `r2_storage_key`. Web seeds are disabled.

The largest non-sample/non-trailer `.mp4` is selected and its MP4 container header checked. This is a BitTorrent-to-object transfer, **not transcoding**: non-MP4 inputs fail clearly instead of being mislabeled. Remux/transcode those inputs before queueing them.

Dependency audit currently flags WebTorrent's transitive `ip` dependency (GHSA-2p57-rm9w-gvfp); npm offers no suitable modern fixed version. The reported `isPublic` path is not called by this runner (the tracker package uses `toString` in its server parser), but the dependency warning remains. Run the torrent process on an isolated host with no access to private network services; do not expose tracker/server ports as an application service.

Only a fully uploaded object with matching size and `video/mp4` metadata becomes `ready`. Uploading does not publish a movie or override its rights review. Public downloads additionally require published status, current verified rights and the existing download kill switch. Existing `/download/[slug]` links route ready videos to `/api/download/resolve?slug=[slug]`.
