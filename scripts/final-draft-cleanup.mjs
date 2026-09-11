import { readFile, writeFile } from 'node:fs/promises';
const key = process.env.TMDB_API_KEY;
if (!key) throw new Error('TMDB_API_KEY required');
const raw = await readFile('tmp/draft-audit.json');
const rows = JSON.parse(raw.toString(raw[0] === 255 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, ''))[0].results;
const imdbByTitle = {'Avatar':'tt0499549','Avatar: The Way of Water':'tt1630029','Inception':'tt1375666','Interstellar':'tt0816692','The Dark Knight':'tt0468569','Oppenheimer':'tt15398776','Gladiator':'tt0172495','Fight Club':'tt0137523','Pulp Fiction':'tt0110912','The Matrix':'tt0133093','Dune: Part Two':'tt15239678','The Shawshank Redemption':'tt0111161','Forrest Gump':'tt0109830','Spider-Man: Across the Spider-Verse':'tt9362722','The Prestige':'tt0482571','Se7en':'tt0114369','Whiplash':'tt2582802','The Avengers':'tt0848228','Top Gun: Maverick':'tt1745960','Joker':'tt7286456'};
for (const row of rows) row.imdb_id ||= imdbByTitle[row.title];
const supported = new Set(['Action', 'Adventure', 'Drama', 'Sci-Fi', 'Thriller']);
const sql = value => `'${String(value ?? '').replaceAll("'", "''")}'`;
const statements = [];
for (const row of rows) {
  const find = await fetch(`https://api.themoviedb.org/3/find/${row.imdb_id}?external_source=imdb_id&api_key=${key}`);
  const f = await find.json(); const id = f.movie_results?.[0]?.id;
  if (!id) continue;
  const detail = await (await fetch(`https://api.themoviedb.org/3/movie/${id}?append_to_response=credits&api_key=${key}`)).json();
  const genre = [...new Set((detail.genres || []).map(x => x.name === 'Science Fiction' ? 'Sci-Fi' : x.name).filter(x => supported.has(x)))].slice(0, 3).join(', ') || 'Drama';
  const directors = (detail.credits?.crew || []).filter(x => x.job === 'Director').map(x => x.name).filter(Boolean).join(', ');
  const cast = (detail.credits?.cast || []).slice(0, 6).map((x, i) => ({ actor: x.name, character: x.character || undefined, image: `/media/cast/${row.imdb_id}-${i + 1}.jpg` }));
  const languages = row.languages_json === '[]' || !row.languages_json ? '["English"]' : row.languages_json;
  const poster = `/media/posters/${row.imdb_id}.jpg`;
  const backdrop = `/media/backdrops/${row.imdb_id}.jpg`;
  statements.push(`UPDATE movies SET genre=${sql(genre)}, director=${sql(directors || row.director || 'Pending editorial review')}, languages_json=${sql(languages)}, poster=${sql(poster)}, backdrop=${sql(backdrop)}, cast_json=${sql(JSON.stringify(cast))}, revision=revision+1 WHERE id=${Number(row.id)} AND publication_status='draft';`);
}
await writeFile('tmp/final-draft-cleanup.sql', statements.join('\n') + '\n', 'utf8');
console.log(JSON.stringify({ rows: rows.length, statements: statements.length }));
