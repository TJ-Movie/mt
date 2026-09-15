'use client';
import { ImagePlus, Plus, Trash2, UserRound } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

export type CastMember =
  | string
  | { actor: string; character?: string; image?: string; profileUrl?: string; profileR2Key?: string; source?: 'yts' | 'tmdb' | 'omdb' | 'manual'; manualOverride?: boolean };

export function CastBuilder({
  cast,
  onChange,
  onUpload,
}: {
  cast: CastMember[];
  onChange: (cast: CastMember[]) => void;
  onUpload?: (file: File, index: number) => void | Promise<void>;
}) {
  const members = cast.map((member) =>
    typeof member === 'string'
      ? { actor: member, character: '', image: '' }
      : member,
  );
  function update(
    index: number,
    key: 'actor' | 'character' | 'image',
    value: string,
  ) {
    onChange(
      members.map((member, itemIndex) =>
        itemIndex === index ? { ...member, [key]: value, manualOverride: true, source: 'manual' as const } : member,
      ),
    );
  }
  return (
    <div className="space-y-3">
      {members.map((member, index) => (
        <div
          key={index}
          className="rounded-xl border border-white/10 bg-black/10 p-4"
        >
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto]">
            <label htmlFor={`cast-actor-${index}`}>
              <span className="mb-1 block text-xs text-white/40">
                Actor name
              </span>
              <Input
                id={`cast-actor-${index}`}
                value={member.actor}
                onChange={(event) => update(index, 'actor', event.target.value)}
                placeholder="Sam Worthington"
              />
            </label>
            <label htmlFor={`cast-character-${index}`}>
              <span className="mb-1 block text-xs text-white/40">
                Character name
              </span>
              <Input
                id={`cast-character-${index}`}
                value={member.character ?? ''}
                onChange={(event) =>
                  update(index, 'character', event.target.value)
                }
                placeholder="Jake Sully"
              />
            </label>
            <div>
              <label htmlFor={`cast-image-${index}`}>
                <span className="mb-1 block text-xs text-white/40">
                  Profile / avatar image URL
                </span>
                <Input
                  id={`cast-image-${index}`}
                  value={member.image ?? member.profileUrl ?? (member.profileR2Key ? '/media/' + member.profileR2Key : '')}
                  onChange={(event) =>
                    update(index, 'image', event.target.value)
                  }
                  placeholder="https://image.tmdb.org/..."
                />
              </label>
              {onUpload ? (
                <label className="mt-2 inline-flex cursor-pointer items-center gap-1.5 text-xs text-[#ef796d] hover:text-white">
                  <ImagePlus size={14} /> Upload profile image
                  <input
                    type="file"
                    accept="image/jpeg,image/png"
                    className="sr-only"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file)
                        void Promise.resolve(onUpload(file, index)).then(
                          () => undefined,
                        );
                    }}
                  />
                </label>
              ) : null}
            </div>
            <Button
              type="button"
              variant="ghost"
              className="self-end text-red-300"
              onClick={() =>
                onChange(members.filter((_, itemIndex) => itemIndex !== index))
              }
              aria-label={`Remove cast member ${member.actor || index + 1}`}
            >
              <Trash2 />
            </Button>
          </div>
        </div>
      ))}
      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            onChange([...members, { actor: '', character: '', image: '' }])
          }
        >
          <Plus /> Add Cast Member
        </Button>
        {members.length === 0 ? (
          <span className="flex items-center gap-2 text-xs text-white/35">
            <UserRound size={14} /> No cast members added yet
          </span>
        ) : null}
      </div>
    </div>
  );
}
