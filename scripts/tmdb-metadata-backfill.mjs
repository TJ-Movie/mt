import { mkdir, writeFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url).pathname.replace(/^\//, '').replaceAll('/', '\\');
const key = process.env.TMDB_API_KEY;
if (!key) throw new Error('TMDB_API_KEY is required');

function sql(value) { return `'${String(value ?? '').replaceAll("'", "''")}'`; }
async function tmdb(path) {
  const response = await fetch(`https://api.themoviedb.org/3${path}${path.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`TMDB_${response.status}`);
  return response.json();
}
const rows = [
  [12,'Avatar','tt0499549'],[13,'Avatar: The Way of Water','tt1630029'],[14,'Inception','tt1375666'],[15,'Interstellar','tt0816692'],[16,'The Dark Knight','tt0468569'],[17,'Oppenheimer','tt15398776'],[18,'Gladiator','tt0172495'],[19,'Fight Club','tt0137523'],[20,'Pulp Fiction','tt0110912'],[21,'The Matrix','tt0133093'],[22,'Dune: Part Two','tt15239678'],[23,'The Shawshank Redemption','tt0111161'],[24,'Forrest Gump','tt0109830'],[25,'Spider-Man: Across the Spider-Verse','tt9362722'],[26,'The Prestige','tt0482571'],[27,'Se7en','tt0114369'],[28,'Whiplash','tt2582802'],[29,'The Avengers','tt0848228'],[30,'Top Gun: Maverick','tt1745960'],[31,'Joker','tt7286456'],
].map(([id,title,imdb_id]) => ({id,title,imdb_id}));
if (!rows.length) throw new Error('No draft records found');
const statements = [];
const uploads = [];
async function mirror(url, keyName) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return '/og.png';
    const bytes = new Uint8Array(await response.arrayBuffer());
    const local = `tmp/r2-assets/${keyName}`;
    await mkdir(local.slice(0, local.lastIndexOf('/')), { recursive: true });
    await writeFile(local, bytes);
    uploads.push({ key: keyName, file: local });
    return `/media/${keyName}`;
  } catch { return '/og.png'; }
}
for (const row of rows) {
  if (!/^tt\d+$/.test(row.imdb_id || '')) continue;
  const found = await tmdb(`/find/${encodeURIComponent(row.imdb_id)}?external_source=imdb_id`);
  const movieId = found.movie_results?.[0]?.id;
  if (!movieId) continue;
  const detail = await tmdb(`/movie/${movieId}?append_to_response=credits`);
  const credits = detail.credits?.cast ?? [];
  const cast = [];
  for (const member of credits.slice(0, 6)) {
    if (!member.name) continue;
    const source = member.profile_path ? `https://image.tmdb.org/t/p/original${member.profile_path}` : '';
    cast.push({ actor: member.name, character: member.character || undefined, image: source ? await mirror(source, `cast/${row.imdb_id}-${cast.length + 1}.jpg`) : '/og.png' });
  }
  const poster = detail.poster_path ? await mirror(`https://image.tmdb.org/t/p/original${detail.poster_path}`, `posters/${row.imdb_id}.jpg`) : '/og.png';
  const backdrop = detail.backdrop_path ? await mirror(`https://image.tmdb.org/t/p/original${detail.backdrop_path}`, `backdrops/${row.imdb_id}.jpg`) : '/og.png';
  const runtime = Number.isInteger(detail.runtime) && detail.runtime > 0 ? `${Math.floor(detail.runtime / 60)}h ${detail.runtime % 60}m` : '';
  const tagline = detail.tagline?.trim() || `Watch ${row.title} in HD`;
  statements.push(`UPDATE movies SET poster=${sql(poster)}, backdrop=${sql(backdrop)}, cast_json=${sql(JSON.stringify(cast))}, runtime=${sql(runtime)}, tagline=${sql(tagline)} WHERE id=${Number(row.id)} AND publication_status='draft';`);
}
const temp = 'tmp/tmdb-metadata-backfill.sql';
await mkdir('tmp', { recursive: true });
await writeFile(temp, `${statements.join('\n')}\n`, 'utf8');
await writeFile('tmp/tmdb-r2-uploads.json', JSON.stringify(uploads), 'utf8');
console.log(JSON.stringify({ drafts: rows.length, updated: statements.length, sqlFile: temp, uploads: uploads.length, manifest: 'tmp/tmdb-r2-uploads.json' }));
