# Cloud media sync

`r2-sync.yml` runs on default-branch pushes, manual dispatch, and every six hours.
The runner queries D1, checks mapped R2 videos, downloads one missing quality
using the existing torrent helpers, and creates `tmp/r2-video-manifest.json`.
No local media or committed manifest is required.

Required repository secrets: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, and `CLOUDFLARE_API_TOKEN` (D1 read/write).
Account, database and bucket are checked against `wrangler.json`.

The cloud manifest tracks the whole D1 snapshot but stages only one video at a
time. The sync worker acquires the next file after uploading and verifying the
current file, then removes its temporary directory. Multipart uploads use two
8 MiB parts concurrently. This bounds disk use despite the CLI concurrency of 5.
Existing fully verified snapshots need no local video and are valid no-op inputs.

D1 quality descriptors and readiness are updated only after HEAD/size checks;
publication status is never changed. Explicit legacy quality mappings are reused.
Unlabelled primary files are not guessed to be 1080p. Stable per-quality keys let
later runs recover uploads completed before a D1 update or runner interruption.

Both transfer workflows share a concurrency group. A job has a 350-minute limit;
unavailable peers, invalid secrets or insufficient disk can still prevent completion.
Acquisition has bounded retries/timeouts, and later scheduled runs resume from
durable R2/D1 state. A continuous loop does not remove GitHub's job time limit.

Permanent Admin deletion also attempts to remove the movie's unshared R2 media
before deleting its D1 row. For direct D1 deletions or historical leftovers, run
`node scripts/purge-orphaned-r2.mjs --dry-run` first, then
`node scripts/purge-orphaned-r2.mjs` after reviewing the
candidate count. The GitHub Actions `r2-sync` manual dispatch exposes the same
operation as an explicit `purge_orphans` option. Normal push and scheduled syncs
never purge orphaned objects. Archived movies remain protected because they still
exist in D1 and may be restored.

Checks: `node --test scripts/cloud-media.test.mjs` and `node --check` on the scripts.
