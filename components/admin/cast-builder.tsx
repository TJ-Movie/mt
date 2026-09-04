'use client';
import { Plus, Trash2, UserRound } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

export type CastMember = string | { actor: string; character?: string; image?: string };

export function CastBuilder({ cast, onChange }: { cast: CastMember[]; onChange: (cast: CastMember[]) => void }) {
  const members = cast.map((member) => typeof member === 'string' ? { actor: member, character: '', image: '' } : member);
  function update(index: number, key: 'actor' | 'character' | 'image', value: string) { onChange(members.map((member, itemIndex) => itemIndex === index ? { ...member, [key]: value } : member)); }
  return <div className="space-y-3">{members.map((member, index) => <div key={`${index}-${member.actor}`} className="rounded-xl border border-white/10 bg-black/10 p-4"><div className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto]"><label><span className="mb-1 block text-xs text-white/40">Actor name</span><Input value={member.actor} onChange={(event) => update(index, 'actor', event.target.value)} placeholder="Sam Worthington" /></label><label><span className="mb-1 block text-xs text-white/40">Character name</span><Input value={member.character ?? ''} onChange={(event) => update(index, 'character', event.target.value)} placeholder="Jake Sully" /></label><label><span className="mb-1 block text-xs text-white/40">Profile / avatar image URL</span><Input value={member.image ?? ''} onChange={(event) => update(index, 'image', event.target.value)} placeholder="https://image.tmdb.org/..." /></label><Button type="button" variant="ghost" className="self-end text-red-300" onClick={() => onChange(members.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remove cast member ${member.actor || index + 1}`}><Trash2 /></Button></div></div>)}<div className="flex flex-wrap gap-3"><Button type="button" variant="outline" onClick={() => onChange([...members, { actor: '', character: '', image: '' }])}><Plus /> Add Cast Member</Button>{members.length === 0 ? <span className="flex items-center gap-2 text-xs text-white/35"><UserRound size={14} /> No cast members added yet</span> : null}</div></div>;
}
