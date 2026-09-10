# Flixlyra production deployment

Production runs directly in Cloudflare account `f0441748220f3ff9c6190e76209f31af`.

- Worker: `flixlyra`
- Custom domain: `https://flixlyra.com`
- Admin: `https://flixlyra.com/studio`
- D1 binding `DB`: `flixlyra-db` (`a8e45cf6-effe-430f-9f7d-3ff85aea0acc`)
- R2 binding `MEDIA`: private bucket `flixlyra-media`

`wrangler.json` is the deployment source of truth. The Vite Cloudflare plugin emits `dist/server/wrangler.json`; do not hand-edit generated output. `.openai/hosting.json` identifies the archived Sites deployment only. Do not deploy production through Sites or reattach its custom domain.

## Deploy from PowerShell

```powershell
npm.cmd run db:migrate
npm.cmd run typecheck
npm.cmd run security:test
npm.cmd run deploy
node --loader ./tests/cloudflare-loader.mjs --test tests/worker-security.integration.mjs
```

Wrangler uses your existing Cloudflare OAuth login. Use `npm.cmd exec wrangler -- login` if it expires. Never place OAuth tokens in source files.

## Access

Cloudflare Access application `Flixlyra Studio` protects `/studio`, `/studio/*`, `/api/admin`, and `/api/admin/*`. It accepts only the email-code identity provider and allows `tharushajayasooriya@gmail.com`. MFA is disabled as requested. Log in through the application URL, not a manually constructed Cloudflare Access login URL.

The application verifies the Access assertion's RS256 signature, issuer, audience, expiration and email allowlist. Plain identity headers do not grant access. Invalid assertions fail closed without restarting login. Direct `workers.dev` requests cannot bypass application authorization. Sign out at `/cdn-cgi/access/logout`.

## Initial data migration: 2026-09-10 (Asia/Colombo)

All 14 existing SQL migrations were applied with Wrangler to the new D1 database. The imported source records were compared row-for-row: 11 movies, 1 setting, 7 approved domains, 57 audit events, 9 comments, and 0 reports. Transient public rate-limit counters were not copied. Eight media objects referenced by those records were copied to R2 and verified byte-for-byte. Unreferenced objects in the old Sites bucket are outside this snapshot.

The initial SQL snapshot and media copies are retained locally under ignored `outputs/cloudflare-migration/`. Do not re-import this snapshot after production edits: it would replace newer records. The original Sites deployment and its database remain available at their original Sites address for recovery.

The two old apex A records (`162.159.143.30`, `172.66.3.26`) were replaced by the Worker-managed DNS record, and the Sites custom-domain attachment was removed. The old verification TXT records were left intact.

## Verification and rollback

`node scripts/verify-cloudflare.mjs https://flixlyra.com` checks the initial 11-entry catalogue snapshot, anonymous admin protection and the eight migrated media hashes. The count is intentionally specific to this initial migration; update that check after legitimate catalogue changes.

For a failed code deployment, use Wrangler's deployment history and rollback to a verified Worker version. Worker rollbacks do not undo D1 or R2 changes. Use D1 Time Travel or a separately reviewed data restore for database recovery. Returning the domain to Sites would require reattaching it through Sites and restoring its DNS targets, and would reintroduce the prior Access routing problem.
