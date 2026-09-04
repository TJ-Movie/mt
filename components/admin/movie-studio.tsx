'use client';

import { createContext, useContext, useMemo, useState } from 'react';
import { Archive, CheckCircle2, ImagePlus, Loader2, Plus, Save, ShieldAlert } from 'lucide-react';
import type { AdminMovie, AuditEvent } from '../../db';
import type { RuntimeControls } from '../../lib/security/runtime-controls';
import { allLanguages, contentTypes, genres } from '../../lib/catalogue-options';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { NativeSelect, NativeSelectOption } from '../ui/native-select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '../ui/alert-dialog';
import { EpisodeBuilder } from './episode-builder';

type EditorContext = { contentType: 'movie' | 'series'; episodes: NonNullable<AdminMovie['episodes']>; setEpisodes: (episodes: NonNullable<AdminMovie['episodes']>) => void };
const ContentTypeContext = createContext<EditorContext>({ contentType: 'movie', episodes: [], setEpisodes: () => undefined });

type DraftMovie = Omit<AdminMovie, 'id' | 'createdAt' | 'updatedAt'> & { id?: number };
type FieldErrors = Record<string, string>;

const emptyMovie: DraftMovie = {
  streamingSources: [],
  downloadSources: [],
  episodes: [],
  revision: 1, slug: '', title: '', contentType: 'movie', tagline: '', description: '', year: new Date().getUTCFullYear(), runtime: '1h 30m', rating: 0,
  genre: 'Drama', director: '', cast: [], languages: ['English'], poster: '/og.png', backdrop: '/og.png', featured: false,
  publicationStatus: 'draft', rightsStatus: 'pending', rightsVerifiedAt: undefined, rightsExpiresAt: undefined,
  rightsReviewer: undefined, rightsReference: undefined, officialWatchUrl: undefined, telegramUrl: undefined, telegramChannel: undefined, subtitleUrl: undefined,
};

function localDate(value?: string): string { return value ? value.slice(0, 10) : ''; }
function isoDate(value: string): string | undefined { return value ? `${value}T12:00:00.000Z` : undefined; }
function nullable(value: string): string | null { const trimmed = value.trim(); return trimmed || null; }

export function MovieStudio({ initialMovies, initialAuditEvents, controls }: { initialMovies: AdminMovie[]; initialAuditEvents: AuditEvent[]; controls: RuntimeControls }) {
  const [movies, setMovies] = useState(initialMovies);
  const [selectedId, setSelectedId] = useState<number | 'new'>(initialMovies[0]?.id ?? 'new');
  const selected = useMemo(() => selectedId === 'new' ? emptyMovie : movies.find((movie) => movie.id === selectedId) ?? emptyMovie, [movies, selectedId]);
  const [draft, setDraft] = useState<DraftMovie>({ ...selected, cast: [...selected.cast], languages: [...selected.languages] });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});

  function choose(movie: AdminMovie | null) {
    setSelectedId(movie?.id ?? 'new');
    const source = movie ?? emptyMovie;
    setDraft({ ...source, cast: [...source.cast], languages: [...source.languages] });
    setMessage(null); setErrors({});
  }

  function update<K extends keyof DraftMovie>(key: K, value: DraftMovie[K]) { setDraft((current) => ({ ...current, [key]: value })); }

  async function save() {
    setBusy(true); setMessage(null); setErrors({});
    const payload = { ...draft, rightsVerifiedAt: nullable(draft.rightsVerifiedAt ?? ''), rightsExpiresAt: nullable(draft.rightsExpiresAt ?? ''), rightsReviewer: nullable(draft.rightsReviewer ?? ''), rightsReference: nullable(draft.rightsReference ?? ''), officialWatchUrl: nullable(draft.officialWatchUrl ?? ''), telegramUrl: nullable(draft.telegramUrl ?? ''), telegramChannel: nullable(draft.telegramChannel ?? ''), subtitleUrl: nullable(draft.subtitleUrl ?? '') };
    const creating = selectedId === 'new';
    const response = await fetch(creating ? '/api/admin/movies' : `/api/admin/movies/${selectedId}`, {
      method: creating ? 'POST' : 'PATCH', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Sublyra-Action': 'admin-write' },
      body: JSON.stringify(creating ? payload : { revision: draft.revision, movie: payload }),
    }).catch(() => null);
    const result = response ? await response.json().catch(() => ({})) as { error?: string } : {};
    if (!response?.ok) { setErrors((result as { fields?: FieldErrors }).fields ?? {}); setMessage({ tone: 'error', text: result.error ?? 'Save failed. Please try again.' }); setBusy(false); return; }
    setMessage({ tone: 'success', text: creating ? 'Movie created safely.' : 'Changes saved.' });
    window.location.reload();
  }

  async function archive() {
    if (selectedId === 'new') return;
    setBusy(true); setMessage(null);
    const response = await fetch(`/api/admin/movies/${selectedId}`, {
      method: 'DELETE', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Sublyra-Action': 'admin-write' },
      body: JSON.stringify({ revision: draft.revision }),
    }).catch(() => null);
    if (!response?.ok) { const result = response ? await response.json().catch(() => ({})) as { error?: string } : {}; setMessage({ tone: 'error', text: result.error ?? 'Archive failed.' }); setBusy(false); return; }
    setMovies((items) => items.filter((movie) => movie.id !== selectedId));
    choose(null); setBusy(false); setMessage({ tone: 'success', text: 'Movie archived and removed from the public catalogue.' });
  }

  async function upload(file: File | undefined, field: 'poster' | 'backdrop' | 'subtitleUrl') {
    if (!file) return;
    setBusy(true); setMessage(null);
    const form = new FormData(); form.set('file', file); if (field === 'subtitleUrl') form.set('kind', 'subtitle');
    const response = await fetch('/api/admin/assets', { method: 'POST', credentials: 'same-origin', headers: { 'X-Sublyra-Action': 'admin-write' }, body: form }).catch(() => null);
    const result = response ? await response.json().catch(() => ({})) as { error?: string; path?: string } : {};
    if (!response?.ok || !result.path) setMessage({ tone: 'error', text: result.error ?? 'Upload failed.' });
    else { update(field, result.path); setMessage({ tone: 'success', text: `${field === 'poster' ? 'Poster' : field === 'backdrop' ? 'Backdrop' : 'Subtitle file'} uploaded.` }); }
    setBusy(false);
  }

  return <ContentTypeContext.Provider value={{ contentType: draft.contentType ?? 'movie', episodes: draft.episodes ?? [], setEpisodes: (episodes) => update('episodes', episodes) }}><div className="mx-auto max-w-[1500px] px-5 py-8 sm:px-8 lg:px-12">
    <div className="mb-7 grid gap-3 sm:grid-cols-3"><StatusCard label="External links" active={controls.externalLinksEnabled}/><StatusCard label="Advertisements" active={controls.adsEnabled}/><div className="rounded-2xl border border-white/10 bg-white/[.035] p-4"><p className="text-xs uppercase tracking-[.18em] text-white/35">Records</p><p className="mt-2 font-serif text-2xl">{movies.length} movies</p></div></div>
    <Tabs defaultValue="catalogue"><TabsList className="bg-white/[.06] text-white/50"><TabsTrigger value="catalogue" className="px-4 text-white/55 data-active:bg-white/10 data-active:text-white">Catalogue</TabsTrigger><TabsTrigger value="audit" className="px-4 text-white/55 data-active:bg-white/10 data-active:text-white">Audit trail</TabsTrigger></TabsList>
      <TabsContent value="catalogue" className="mt-6"><div className="grid gap-6 xl:grid-cols-[360px_1fr]">
        <aside className="rounded-2xl border border-white/10 bg-white/[.035] p-4"><Button onClick={() => choose(null)} className="h-11 w-full rounded-xl bg-[#ef796d] text-white"><Plus/> Add movie</Button><div className="mt-4 max-h-[72vh] space-y-2 overflow-y-auto">{movies.map((movie) => <button key={movie.id} onClick={() => choose(movie)} className={`w-full rounded-xl border p-4 text-left transition ${selectedId === movie.id ? 'border-[#ef796d]/70 bg-[#ef796d]/10' : 'border-white/8 bg-black/10 hover:border-white/20'}`}><div className="flex items-start justify-between gap-3"><div><p className="font-serif text-lg">{movie.title}</p><p className="mt-1 text-xs text-white/40">{movie.slug}</p></div><span className={`rounded-full px-2 py-1 text-[11px] ${movie.publicationStatus === 'published' ? 'bg-emerald-400/10 text-emerald-300' : 'bg-white/8 text-white/45'}`}>{movie.publicationStatus}</span></div><p className="mt-3 text-xs text-white/35">Rights: {movie.rightsStatus} · rev {movie.revision}</p></button>)}</div></aside>
        <section className="rounded-2xl border border-white/10 bg-[#171916] p-5 sm:p-7"><div className="flex flex-col gap-4 border-b border-white/10 pb-5 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-xs uppercase tracking-[.2em] text-[#ef796d]">{selectedId === 'new' ? 'New record' : 'Editing record'}</p><h1 className="mt-2 font-serif text-3xl">{draft.title || 'Untitled film'}</h1></div><div className="flex gap-2"><Button disabled={busy} onClick={save} className="h-10 rounded-full bg-[#ef796d] px-5 text-white">{busy ? <Loader2 className="animate-spin"/> : <Save/>} Save</Button>{selectedId !== 'new' && <AlertDialog><AlertDialogTrigger render={<Button disabled={busy} variant="destructive" className="h-10 rounded-full px-4"/>}><Archive/> Archive</AlertDialogTrigger><AlertDialogContent className="border border-white/10 bg-[#f2efe9] text-[#181916]"><AlertDialogHeader><AlertDialogTitle>Archive this movie?</AlertDialogTitle><AlertDialogDescription>It will immediately disappear from the public catalogue. The audit record remains.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={archive} className="bg-[#b43a2e] text-white">Archive</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>}</div></div>
          {message && <div className={`mt-5 rounded-xl border px-4 py-3 text-sm ${message.tone === 'success' ? 'border-emerald-400/20 bg-emerald-400/8 text-emerald-200' : 'border-red-400/20 bg-red-400/8 text-red-200'}`}><div className="flex items-center gap-2">{message.tone === 'success' ? <CheckCircle2/> : <ShieldAlert/>}{message.text}</div>{Object.keys(errors).length > 0 && <ul className="mt-3 list-disc space-y-1 pl-6 text-red-200/80">{Object.entries(errors).map(([field, error]) => <li key={field}><span className="font-semibold">{fieldLabel(field)}:</span> {error}</li>)}</ul>}</div>}
          <div className="mt-6 grid gap-5 md:grid-cols-2"><Field label="Title"><Input maxLength={160} value={draft.title} onChange={(e) => update('title', e.target.value)}/></Field><Field label="Slug"><Input maxLength={80} value={draft.slug} onChange={(e) => update('slug', e.target.value.toLowerCase())}/></Field><Field label="Tagline" wide><Input maxLength={200} value={draft.tagline} onChange={(e) => update('tagline', e.target.value)}/></Field><Field label="Description" wide><Textarea maxLength={2000} value={draft.description} onChange={(e) => update('description', e.target.value)} className="min-h-28"/></Field><Field label="Release year"><Input type="number" min={1888} max={new Date().getUTCFullYear()+5} value={draft.year} onChange={(e) => update('year', Number(e.target.value))}/></Field><Field label="Rating (0-10)"><Input type="number" min={0} max={10} step="0.1" value={draft.rating} onChange={(e) => update('rating', Number(e.target.value))}/></Field><Field label="Runtime"><Input maxLength={30} value={draft.runtime} onChange={(e) => update('runtime', e.target.value)}/></Field><Field label="Genre"><NativeSelect value={draft.genre} onChange={(e) => update('genre', e.target.value)} className="w-full">{genres.filter((genre) => genre !== 'All').map((genre) => <NativeSelectOption key={genre} value={genre}>{genre}</NativeSelectOption>)}</NativeSelect></Field><Field label="Director"><Input maxLength={160} value={draft.director} onChange={(e) => update('director', e.target.value)}/></Field><Field label="Cast (comma separated)"><Input value={draft.cast.join(', ')} onChange={(e) => update('cast', e.target.value.split(',').map((value) => value.trim()).filter(Boolean))}/></Field>
            <Field label="Publication"><NativeSelect value={draft.publicationStatus} onChange={(e) => update('publicationStatus', e.target.value as DraftMovie['publicationStatus'])} className="w-full"><NativeSelectOption value="draft">Draft</NativeSelectOption><NativeSelectOption value="published">Published</NativeSelectOption><NativeSelectOption value="archived">Archived</NativeSelectOption></NativeSelect></Field><Field label="Rights status"><NativeSelect value={draft.rightsStatus} onChange={(e) => update('rightsStatus', e.target.value as DraftMovie['rightsStatus'])} className="w-full"><NativeSelectOption value="pending">Pending</NativeSelectOption><NativeSelectOption value="verified">Verified</NativeSelectOption><NativeSelectOption value="blocked">Blocked</NativeSelectOption></NativeSelect></Field><Field label="Rights verified at"><Input type="date" value={localDate(draft.rightsVerifiedAt)} onChange={(e) => update('rightsVerifiedAt', isoDate(e.target.value))}/></Field><Field label="Rights expires at"><Input type="date" value={localDate(draft.rightsExpiresAt)} onChange={(e) => update('rightsExpiresAt', isoDate(e.target.value))}/></Field><Field label="Rights reviewer"><Input maxLength={120} value={draft.rightsReviewer ?? ''} onChange={(e) => update('rightsReviewer', e.target.value)}/></Field><Field label="Evidence reference"><Input maxLength={160} value={draft.rightsReference ?? ''} onChange={(e) => update('rightsReference', e.target.value)}/></Field><Field label="Official YouTube URL" wide><Input maxLength={500} value={draft.officialWatchUrl ?? ''} onChange={(e) => update('officialWatchUrl', e.target.value)}/></Field><Field label="Telegram URL"><Input maxLength={500} value={draft.telegramUrl ?? ''} onChange={(e) => update('telegramUrl', e.target.value)}/></Field><Field label="Telegram channel"><Input maxLength={32} value={draft.telegramChannel ?? ''} onChange={(e) => update('telegramChannel', e.target.value)}/></Field>
            <UploadField label="Poster" value={draft.poster} accept="image/jpeg,image/png" onUpload={(file) => upload(file, 'poster')}/><UploadField label="Backdrop" value={draft.backdrop} accept="image/jpeg,image/png" onUpload={(file) => upload(file, 'backdrop')}/><UploadField label="Subtitle ZIP / 7Z / SRT / VTT" value={draft.subtitleUrl ?? ''} accept=".zip,.7z,.srt,.vtt,application/zip,application/x-7z-compressed,text/plain,text/vtt" onUpload={(file) => upload(file, 'subtitleUrl')}/><label className="flex items-center gap-3 text-sm text-white/65"><input type="checkbox" checked={draft.featured} onChange={(e) => update('featured', e.target.checked)} className="size-4 accent-[#ef796d]"/> Featured film</label>
            <Field label="Subtitle languages" wide><div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{allLanguages.map((language) => <label key={language} className="flex items-center gap-2 rounded-lg border border-white/8 px-3 py-2 text-sm text-white/60"><input type="checkbox" checked={draft.languages.includes(language)} onChange={(e) => update('languages', e.target.checked ? [...draft.languages, language] : draft.languages.filter((item) => item !== language))} className="accent-[#ef796d]"/>{language}</label>)}</div></Field>
          </div>
          <div className="mt-5 grid gap-5 border-t border-white/10 pt-5 md:grid-cols-2"><Field label="Content type"><NativeSelect value={draft.contentType ?? 'movie'} onChange={(e) => update('contentType', e.target.value as DraftMovie['contentType'])} className="w-full">{contentTypes.map((type) => <NativeSelectOption key={type} value={type}>{type === 'series' ? 'TV Series' : 'Movie'}</NativeSelectOption>)}</NativeSelect></Field><Field label="Multiple categories"><div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{genres.filter((genre) => genre !== 'All').map((genre) => { const selectedGenres = draft.genre.split(',').map((item) => item.trim()).filter(Boolean); return <label key={genre} className="flex items-center gap-2 rounded-lg border border-white/8 px-3 py-2 text-sm text-white/60"><input type="checkbox" checked={selectedGenres.includes(genre)} onChange={(e) => update('genre', e.target.checked ? [...new Set([...selectedGenres, genre])].join(', ') : selectedGenres.filter((item) => item !== genre).join(', '))} className="accent-[#ef796d]"/>{genre}</label>; })}</div></Field></div>
          <div className="mt-5 space-y-5 border-t border-white/10 pt-5"><Field label="Series episodes (one per line: S01E01 | Episode title | optional URL)" wide><Textarea value={(draft.episodes ?? []).map((episode) => `S${String(episode.season).padStart(2, '0')}E${String(episode.episode).padStart(2, '0')} | ${episode.title} | ${episode.url ?? ''}`).join('\n')} onChange={(e) => update('episodes', e.target.value.split('\n').map((line) => { const [code, title, url] = line.split('|').map((item) => item.trim()); const match = /^S(\d+)E(\d+)$/i.exec(code ?? ''); return match && title ? { season: Number(match[1]), episode: Number(match[2]), title, url: url || undefined } : null; }).filter(Boolean) as DraftMovie['episodes'])} placeholder={'S01E01 | Pilot | https://source.example/episode-1\nS01E02 | The second signal | https://source.example/episode-2'} className="min-h-32"/></Field><Field label="Streaming servers (one per line: Label | Embed URL)" wide><Textarea value={(draft.streamingSources ?? []).map((source) => `${source.label} | ${source.url}`).join('\n')} onChange={(e) => update('streamingSources', e.target.value.split('\n').map((line) => { const [label, ...url] = line.split('|'); return { label: (label ?? '').trim(), url: url.join('|').trim() }; }).filter((source) => source.label || source.url))} placeholder="Server 1 | https://player.example.com/embed/123" className="min-h-24"/></Field><Field label="Download options (URL alone, or Label | Quality | Resolution | Size | URL)" wide><Textarea value={(draft.downloadSources ?? []).map((source) => `${source.label} | ${source.quality} | ${source.resolution} | ${source.size} | ${source.url}`).join('\n')} onChange={(e) => update('downloadSources', e.target.value.split('\n').map((line,index) => { const parts=line.split('|').map((item)=>item.trim()); if(parts.length===1&&/^https:\/\//i.test(parts[0]??''))return {label:`Download ${index+1}`,quality:'Standard',resolution:'Auto',size:'Unknown',url:parts[0]}; const [label, quality, resolution, size, ...url]=parts; return {label:label??'',quality:quality??'',resolution:resolution??'',size:size??'',url:url.join('|')}; }).filter((source) => source.url))} placeholder={'https://pixeldrain.com/u/example\nDirect 2 | WEB-DL | 1080p | 2.4 GB | https://doodstream.com/d/example'} className="min-h-28"/></Field></div>
        </section></div></TabsContent>
      <TabsContent value="audit" className="mt-6 rounded-2xl border border-white/10 bg-white/[.035] p-4 sm:p-6"><Table><TableHeader><TableRow className="border-white/10"><TableHead className="text-white/45">Time</TableHead><TableHead className="text-white/45">Action</TableHead><TableHead className="text-white/45">Movie</TableHead><TableHead className="text-white/45">Editor</TableHead></TableRow></TableHeader><TableBody>{initialAuditEvents.map((event) => <TableRow key={event.id} className="border-white/8 hover:bg-white/[.03]"><TableCell className="text-white/45">{new Date(event.createdAt).toLocaleString()}</TableCell><TableCell>{event.action}</TableCell><TableCell>{event.movieSlug ?? '—'}</TableCell><TableCell className="text-white/45">{event.actorEmail}</TableCell></TableRow>)}</TableBody></Table></TabsContent>
    </Tabs>
  </div></ContentTypeContext.Provider>;
}

function StatusCard({ label, active }: { label: string; active: boolean }) { return <div className="rounded-2xl border border-white/10 bg-white/[.035] p-4"><p className="text-xs uppercase tracking-[.18em] text-white/35">{label}</p><p className={`mt-2 flex items-center gap-2 font-serif text-2xl ${active ? 'text-amber-200' : 'text-emerald-300'}`}><span className={`size-2 rounded-full ${active ? 'bg-amber-300' : 'bg-emerald-300'}`}/>{active ? 'Enabled' : 'Safe-disabled'}</p></div>; }
function fieldLabel(field: string): string { return field.replace(/([A-Z])/g, ' $1').replace(/^./, (value) => value.toUpperCase()); }
function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) { const context = useContext(ContentTypeContext); const isEpisode = label.startsWith('Series episodes'); const isMovieOnly = label.startsWith('Streaming servers') || label.startsWith('Download options'); if ((isEpisode && context.contentType !== 'series') || (isMovieOnly && context.contentType === 'series')) return null; const content = isEpisode ? <EpisodeBuilder episodes={context.episodes} onChange={context.setEpisodes}/> : children; return <label className={wide ? 'md:col-span-2' : ''}><span className="mb-2 block text-xs font-semibold uppercase tracking-[.14em] text-white/40">{label}</span><div className="[&_input]:h-10 [&_input]:border-white/12 [&_input]:bg-black/15 [&_input]:text-white [&_textarea]:border-white/12 [&_textarea]:bg-black/15 [&_textarea]:text-white [&_select]:h-10 [&_select]:border-white/12 [&_select]:bg-black/15 [&_select]:text-white">{content}</div></label>; }
function UploadField({ label, value, accept, onUpload }: { label: string; value: string; accept: string; onUpload: (file?: File) => void }) { return <Field label={label}><div className="flex gap-2"><Input readOnly value={value}/><Button type="button" variant="outline" className="relative h-10 shrink-0 overflow-hidden border-white/15 bg-transparent text-white"><ImagePlus/> Upload<input type="file" accept={accept} onChange={(event) => { onUpload(event.target.files?.[0]); event.target.value = ''; }} className="absolute inset-0 cursor-pointer opacity-0" aria-label={`Upload ${label.toLowerCase()}`}/></Button></div></Field>; }
