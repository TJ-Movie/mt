'use client';
import { Plus, Trash2, ImagePlus } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { NativeSelect, NativeSelectOption } from '../ui/native-select';
import type { AdminMovie } from '../../db';

type Episode = NonNullable<AdminMovie['episodes']>[number];

export function EpisodeBuilder({ episodes, onChange }: { episodes: Episode[]; onChange: (episodes: Episode[]) => void }) {
  function update(index: number, key: keyof Episode, value: string) {
    onChange(episodes.map((episode, itemIndex) => itemIndex === index
      ? { ...episode, [key]: key === 'season' || key === 'episode' ? Math.max(1, Number(value) || 1) : value }
      : episode));
  }

  async function upload(index: number, field: 'thumbnail' | 'backdrop', file?: File) {
    if (!file) return;
    const form = new FormData(); form.set('file', file);
    const response = await fetch('/api/admin/assets', { method: 'POST', credentials: 'same-origin', headers: { 'X-Sublyra-Action': 'admin-write' }, body: form });
    const result = await response.json().catch(() => ({})) as { path?: string };
    if (response.ok && result.path) update(index, field, result.path);
  }

  return <div className="space-y-3">
    {episodes.map((episode, index) => <div key={`${index}-${episode.season}-${episode.episode}`} className="space-y-4 rounded-xl border border-white/10 bg-black/10 p-4">
      <div className="grid gap-3 md:grid-cols-[100px_100px_1fr_1fr_auto]">
        <label><span className="mb-1 block text-xs text-white/40">Season</span><Input type="number" min={1} value={episode.season} onChange={(event) => update(index, 'season', event.target.value)} /></label>
        <label><span className="mb-1 block text-xs text-white/40">Episode</span><Input type="number" min={1} value={episode.episode} onChange={(event) => update(index, 'episode', event.target.value)} /></label>
        <label><span className="mb-1 block text-xs text-white/40">Title</span><Input value={episode.title} onChange={(event) => update(index, 'title', event.target.value)} placeholder="Episode title" /></label>
        <label><span className="mb-1 block text-xs text-white/40">Stream link</span><Input value={episode.url ?? ''} onChange={(event) => update(index, 'url', event.target.value)} placeholder="https://..." /></label>
        <Button type="button" variant="ghost" className="self-end text-red-300" onClick={() => onChange(episodes.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remove episode ${episode.season}-${episode.episode}`}><Trash2 /></Button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <ArtworkField label="Episode Poster" value={episode.thumbnail ?? ''} onUrlChange={(value) => update(index, 'thumbnail', value)} onUpload={(file) => upload(index, 'thumbnail', file)} />
        <ArtworkField label="Episode Backdrop / Cover" value={episode.backdrop ?? ''} onUrlChange={(value) => update(index, 'backdrop', value)} onUpload={(file) => upload(index, 'backdrop', file)} />
        <label><span className="mb-1 block text-xs text-white/40">Rating / score</span><Input type="number" min={0} max={10} step="0.1" value={episode.rating ?? ''} onChange={(event) => update(index, 'rating', event.target.value)} /></label>
        <label><span className="mb-1 block text-xs text-white/40">Download controls</span><NativeSelect value={episode.downloadStatus ?? ((episode.downloadSources?.length ?? 0) > 0 ? 'available' : 'pending')} onChange={(event) => update(index, 'downloadStatus', event.target.value)}><NativeSelectOption value="available">Available</NativeSelectOption><NativeSelectOption value="pending">Download Pending / Coming Soon</NativeSelectOption></NativeSelect></label>
        <label className="md:col-span-2"><span className="mb-1 block text-xs text-white/40">Episode overview</span><Textarea value={episode.description ?? ''} onChange={(event) => update(index, 'description', event.target.value)} placeholder="Short episode description" className="min-h-20" /></label>
        <label className="md:col-span-2"><span className="mb-1 block text-xs text-white/40">Download mirrors (one URL per line)</span><Textarea value={(episode.downloadSources ?? []).map((source) => `${source.label} | ${source.quality} | ${source.resolution} | ${source.size} | ${source.url}`).join('\n')} onChange={(event) => update(index, 'downloadSources', event.target.value.split('\n').map((line, mirrorIndex) => { const parts = line.split('|').map((part) => part.trim()); if (parts.length === 1 && /^https:\/\//i.test(parts[0] ?? '')) return { label: `Download ${mirrorIndex + 1}`, quality: 'Standard', resolution: 'Auto', size: 'Unknown', url: parts[0] }; const [label, quality, resolution, size, ...url] = parts; return { label: label ?? '', quality: quality ?? '', resolution: resolution ?? '', size: size ?? '', url: url.join('|') }; }).filter((source) => source.url))} placeholder="Server 1 | WEB-DL | 1080p | 1.2 GB | https://..." className="min-h-20" /></label>
      </div>
    </div>)}
    <Button type="button" variant="outline" onClick={() => onChange([...episodes, { season: 1, episode: episodes.length + 1, title: '', url: undefined, downloadStatus: 'pending' }])}><Plus /> Add episode</Button>
    <p className="text-xs text-white/40">Upload JPG, PNG, or WebP artwork. Files are saved as media paths in the existing episode data.</p>
  </div>;
}

function ArtworkField({ label, value, onUrlChange, onUpload }: { label: string; value: string; onUrlChange: (value: string) => void; onUpload: (file?: File) => void }) {
  return <div><span className="mb-1 block text-xs text-white/40">{label}</span><div className="flex gap-2"><Input value={value} onChange={(event) => onUrlChange(event.target.value)} placeholder="/media/... or https://..." /><Button type="button" variant="outline" className="relative h-10 shrink-0 overflow-hidden border-white/15 bg-transparent text-white"><ImagePlus size={15} /> Upload<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { onUpload(event.target.files?.[0]); event.currentTarget.value = ''; }} className="absolute inset-0 cursor-pointer opacity-0" aria-label={`Upload ${label}`} /></Button></div></div>;
}
