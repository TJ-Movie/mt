# Normal cloud media ingestion

Studio accepts up to 20 valid IMDb/YTS-supported IDs and automatically dispatches one scoped r2-sync.yml run after light YTS metadata is saved. The normal operator does not select qualities, manage leases, or run recovery controls. Manual workflow inputs remain developer-only recovery mechanisms.

The Studio route stores only light title/year/IMDb/source identifiers, torrent descriptors, supported qualities, and source size labels. It does not fetch or persist heavy artwork or cast assets at ingest time.

The runner builds a scoped manifest and uses a bounded pool of 2 movie jobs. Each movie processes 720p and 1080p sequentially so its D1 revision/lease state is serialized; different movies can progress concurrently. A stalled movie therefore does not block the next movie in a batch. The sync CLI also defaults to concurrency 2, and the workflow passes concurrency 2 explicitly to keep torrent piece stores, writers, and multipart uploads within the GitHub runner disk and memory budget.

Each quality is committed independently. Download completion is followed by expected-file selection, MP4 validation, R2 upload, R2 HEAD/content-type/size verification, and a guarded D1 revision/lease commit. Only then is that quality verified. Two verified qualities produce READY; exactly one produces HALF/PARTIAL; zero produces FAILED/UNAVAILABLE. A failed quality never removes a verified quality.

Enrichment runs only after at least one quality has passed the full verification chain. Poster, backdrop, cast images, director/details, and other enrichment metadata are stored with their own pending, ready, or failed status. Enrichment failure preserves verified media, and enrichment-only retry does not re-download media. When both qualities fail, new heavy artwork/cast storage is skipped; valid older assets are not deleted automatically.

Acquisition has bounded metadata and byte-progress watchdogs. Metadata is limited by TRANSFER_METADATA_TIMEOUT_SECONDS (default 90 seconds). Once file information exists, TRANSFER_NO_PROGRESS_TIMEOUT_SECONDS (default 120 seconds) is reset only by positive bytes crossing the real media pipeline. Failures are classified as METADATA_TIMEOUT, NO_PEERS, ZERO_BYTE_STALL, DOWNLOAD_STALLED, or SOURCE_INVALID. Timeout abort destroys streams, writers, torrent clients, and temporary pieces before the quality is recorded as failed.

Terminal dead-source failures do not retry the identical source. Transfer retries are bounded and reserved for non-terminal errors. Scoped transfer ownership is released on every failure, publication and rights state are never changed by ingestion, and verified R2 objects are never broadly deleted.

The GitHub job ceiling is emergency-only; normal dead-source detection occurs inside application logic. The existing optional orphan-cleanup step and separate recovery scripts are not part of normal ingestion.

Checks include node --test scripts/cloud-media.test.mjs, the real-path torrent tests, phase 3 orchestration tests, and the repository typecheck/lint/build/security suites.