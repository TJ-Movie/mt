export type CastMember = {
  actor: string;
  character?: string;
  image?: string;
  profileUrl?: string;
  profileR2Key?: string;
  source?: 'yts' | 'tmdb' | 'omdb' | 'manual';
  manualOverride?: boolean;
};

export type CastParseResult = { members: CastMember[]; parseError: boolean };

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.normalize('NFKC').trim().slice(0, max) : '';
}

export function normalizeCast(value: unknown): CastMember[] {
  if (!Array.isArray(value)) return [];
  const members: CastMember[] = [];
  for (const item of value.slice(0, 100)) {
    if (typeof item === 'string') {
      const actor = text(item, 120);
      if (actor) members.push({ actor });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const source = item as Record<string, unknown>;
    const actor = text(source.actor ?? source.name, 120);
    if (!actor) continue;
    const character = text(source.character ?? source.character_name, 120);
    const image = text(source.image ?? source.profileUrl ?? source.profile_url, 500);
    const profileR2Key = text(source.profileR2Key ?? source.profile_r2_key, 240);
    const profileUrl = text(source.profileUrl ?? source.profile_url ?? source.image, 500);
    const sourceName = source.source;
    const provenance = sourceName === 'yts' || sourceName === 'tmdb' || sourceName === 'omdb' || sourceName === 'manual' ? sourceName : undefined;
    members.push({
      actor,
      ...(character ? { character } : {}),
      ...(image ? { image } : {}),
      ...(profileUrl ? { profileUrl } : {}),
      ...(profileR2Key ? { profileR2Key } : {}),
      ...(provenance ? { source: provenance } : {}),
      ...(source.manualOverride === true ? { manualOverride: true } : {}),
    });
  }
  return members;
}

export function parseCastJson(json: string): CastParseResult {
  try {
    const parsed: unknown = JSON.parse(json || '[]');
    if (!Array.isArray(parsed)) return { members: [], parseError: true };
    return { members: normalizeCast(parsed), parseError: false };
  } catch {
    return { members: [], parseError: true };
  }
}

export function castName(member: CastMember | string): string {
  return typeof member === 'string' ? member : member.actor;
}

export function castImage(member: CastMember | string): string | undefined {
  if (typeof member === 'string') return undefined;
  return member.profileR2Key ? `/media/${member.profileR2Key}` : member.image ?? member.profileUrl;
}
