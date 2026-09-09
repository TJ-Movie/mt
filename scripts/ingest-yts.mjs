#!/usr/bin/env node
const DEFAULT_IDS = ['tt0499549','tt1630029','tt1375666','tt0816692','tt0468569','tt15398776','tt0172495','tt0137523','tt0110912','tt0133093','tt15239678','tt0111161','tt0109830','tt9362722','tt0482571','tt0114369','tt2582802','tt0848228','tt1745960','tt7286456'];
const args = process.argv.slice(2);
const url = process.env.SUBLYRA_ADMIN_URL || args.find((value) => value.startsWith('http'));
const cookie = process.env.SUBLYRA_ADMIN_COOKIE;
const ids = args.filter((value) => /^tt\d{7,10}$/.test(value));
if (!url || !cookie) {
  console.error('Usage: SUBLYRA_ADMIN_URL=https://flixlyra.com/api/admin/ingest/yts SUBLYRA_ADMIN_COOKIE="..." node scripts/ingest-yts.mjs [IMDb IDs]');
  process.exit(2);
}
const response = await fetch(url, {
  method: 'POST',
  headers: { accept: 'application/json', 'content-type': 'application/json', origin: new URL(url).origin, 'sec-fetch-site': 'same-origin', 'x-sublyra-action': 'admin-write', cookie },
  body: JSON.stringify({ imdbIds: (ids.length ? ids : DEFAULT_IDS).slice(0, 20) }),
});
const body = await response.text();
console.log(body);
if (!response.ok) process.exitCode = 1;
