# Sublyra Security Operations

## Dependency update and lockfile policy

The hardened compatibility set is pinned exactly in `package.json`:

- `react`, `react-dom`, `react-server-dom-webpack`: `19.2.8`
- `vinext`: `1.0.0-beta.9`
- `vite`: `8.2.2`
- `@vitejs/plugin-rsc`: `0.5.34`
- `@cloudflare/vite-plugin`: `1.54.3`
- `wrangler`: `4.128.0`
- `@cloudflare/workers-types`: `5.20260903.1`

Update React, React DOM, RSC, Vinext, Vite, and the RSC plugin as one tested set.
Never use `npm audit fix --force` or `--legacy-peer-deps` to bypass peer checks.
After an approved update:

1. Use a clean npm cache and run `npm install` to regenerate `package-lock.json`.
2. Verify `npm ci` in a clean workspace.
3. Run `npm audit --omit=dev`, `npm run lint`, `npm run security:test`, the
   TypeScript no-emit check, and `npm run build`.
4. Review the lockfile diff for unexpected registries, Git dependencies,
   lifecycle scripts, duplicate React/RSC versions, or unexplained package jumps.
5. Commit `package.json` and `package-lock.json` together.

## Fail-closed production switches

Production environment values are managed by Sites, not committed to source:

| Key | Safe value | Effect |
|---|---|---|
| `SUBLYRA_EXTERNAL_LINKS_ENABLED` | `false` | Denies every watch/Telegram redirect. |
| `SUBLYRA_ADS_ENABLED` | `false` | Removes all advertisement placements. |

Only the exact case-insensitive value `true` enables a feature. Missing, empty,
or malformed values remain disabled. A switch change requires a saved-version
deployment so the production environment revision is applied.

## Rights approval requirements

A movie remains denied unless all of these are true:

- `rightsStatus` is `verified`;
- `rightsVerifiedAt` is a valid timestamp that is not in the future;
- `rightsExpiresAt` is a valid future timestamp;
- `rightsReviewer` and `rightsReference` are non-empty;
- the global external-link switch is enabled; and
- the destination passes its exact URL-shape validation.

Changing a destination, channel, territory, term, or rights reference must reset
the status to `pending`. Use `blocked` immediately for a takedown or incident.
Retain the evidence outside the public repository and reference it by a
non-sensitive identifier only.

## Outbound destination rules

- YouTube: `https://www.youtube.com/watch?v=<11-char-id>` or
  `https://youtu.be/<11-char-id>`; only the optional `t` parameter is accepted.
- Telegram: `https://t.me/<approved-channel>` with an optional numeric message
  ID. The channel must match the record's `telegramChannel` field.
- User information, custom ports, fragments, insecure HTTP, lookalike domains,
  invite links, and unapproved query parameters are denied.
- Redirect and error responses are `no-store`; destination URLs are not written
  to application logs or public DTOs.

## Edge rate limiting

The API advertises `RateLimit-Policy: 60;w=60`; the header is documentation, not
enforcement. Before public access, configure the hosting edge to enforce:

- `/api/movies`: 60 requests per source per rolling 60 seconds;
- `/out/*`: 30 requests per source per rolling 60 seconds;
- any future authentication/admin write: 5 failed attempts per 15 minutes and
  a separate low write limit.

Return `429` with a bounded `Retry-After`, do not reflect request values, and log
only the rule ID, route class, action, and outcome. Keep catalogue results cached
at the edge. Do not use an isolate-local `Map` as a security boundary because
Workers are distributed and limited to 128 MB per isolate.

## Self-hosted movie assets

The catalogue currently references the local `/og.png` safety artwork, so visitor
browsers no longer contact Unsplash. Before replacing it:

1. Accept only rights-cleared JPEG, PNG, AVIF, or WebP assets.
2. Decode and re-encode uploads outside the public request path; strip metadata.
3. Enforce pixel, file-size, and decompressed-size limits before publication.
4. Store content-addressed filenames and record the license/evidence reference.
5. Serve assets from the same controlled origin with immutable versioned caching,
   `nosniff`, and a correct fixed content type.
6. Never serve unreviewed SVG/HTML as movie artwork.

## CSP and JSON-LD

`proxy.ts` generates a fresh nonce for every request, forwards the CSP to Vinext
so framework scripts/styles receive the nonce, and returns the same policy to the
browser. Do not add `unsafe-inline`, `unsafe-eval`, wildcard script origins, or
arbitrary third-party script hosts. `serializeJsonLd` must remain the only JSON-LD
serializer; its regression test verifies that HTML terminators and Unicode line
separators are escaped.

## Security events and incident handling

Structured security events are single-line JSON. They contain event name, time,
movie slug, action, and denial reason only. Never add authorization headers,
cookies, request bodies, private destination URLs, query tokens, or rights files.

Alert on destination/config changes, repeated redirect denials, rate-limit spikes,
5xx increases, dependency disclosures, and deployment rollback. For a suspected
incident: set both switches to `false`, set affected records to `blocked`, deploy,
preserve sanitized logs and version IDs, investigate, rotate any exposed secret,
and restore only after a new rights/security approval.
