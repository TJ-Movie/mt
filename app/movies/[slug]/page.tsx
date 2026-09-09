import type { Metadata } from 'next';
import { MediaSourcesGateway } from '../../../components/media-sources-gateway';
import { PendingDownloadRedirect } from '../../../components/pending-download-redirect';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  ChevronDown,
  Clock3,
  Download,
  Film,
  Globe2,
  Play,
  ShieldCheck,
  Star,
  UserRound,
} from 'lucide-react';
import { movies } from '../../../lib/movies';
import { getPublishedMovie } from '../../../db';
import { resolveOutboundDestination } from '../../../lib/security/outbound-links';
import { getRuntimeControls } from '../../../lib/security/runtime-controls';
import { MovieComments } from '../../../components/movie-comments';
import { CastList } from '../../../components/cast-list';
import { TrailerModal } from '../../../components/trailer-modal';
import { ShareButtons } from '../../../components/share-buttons';

export function generateStaticParams() {
  return movies.map((movie) => ({ slug: movie.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const movie = await getPublishedMovie((await params).slug);
  if (!movie) return { title: 'Film not found — Flixlyra' };
  const description = `${movie.tagline} Explore ${movie.title}, cast, rating, and ${movie.languages.length} subtitle languages on Flixlyra.`;
  return {
    title: `${movie.title} — Flixlyra`,
    description,
    openGraph: {
      title: `${movie.title} — Flixlyra`,
      description,
      images: [
        { url: movie.backdrop, alt: `${movie.title} cinematic artwork` },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${movie.title} — Flixlyra`,
      description,
      images: [movie.backdrop],
    },
  };
}

export default async function MoviePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const movie = await getPublishedMovie((await params).slug);
  if (!movie) notFound();
  const controls = getRuntimeControls();
  const watchAvailable = resolveOutboundDestination(
    movie,
    'watch',
    controls,
  ).ok;
  const telegramAvailable = resolveOutboundDestination(
    movie,
    'telegram',
    controls,
  ).ok;
  const gatewayAvailable =
    controls.externalLinksEnabled &&
    movie.rightsStatus === 'verified' &&
    (movie.downloadSources?.length ?? 0) > 0;
  const sourcesAvailable =
    controls.externalLinksEnabled && movie.rightsStatus === 'verified';
  return (
    <main className="min-h-screen bg-[#171815] text-white">
      <section className="relative min-h-[680px] overflow-hidden sm:min-h-[720px]">
        <img
          src={movie.backdrop}
          alt=""
          className="absolute inset-0 h-full w-full object-cover opacity-55"
        />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,#171815_0%,rgba(23,24,21,.86)_42%,rgba(23,24,21,.18)_75%),linear-gradient(0deg,#171815_0%,transparent_55%)]" />
        <div className="relative mx-auto max-w-[1380px] px-4 pb-14 pt-5 sm:px-8 sm:pb-20 sm:pt-8 lg:px-12">
          <div className="flex items-center justify-between">
            <a
              href="/"
              className="flex min-h-11 items-center gap-2 text-sm text-white/65 hover:text-white"
            >
              <ArrowLeft size={16} /> Back to collection
            </a>
            <a href="/" className="font-serif text-xl sm:text-2xl">
              Flixlyra<span className="text-[#ef796d]">.</span>
            </a>
          </div>
          <div className="grid min-h-[600px] items-end gap-8 pt-14 sm:pt-20 md:min-h-[590px] md:grid-cols-[250px_1fr] md:items-center md:gap-10">
            <img
              src={movie.poster}
              alt={`${movie.title} poster`}
              className="hidden aspect-[2/3] w-full bg-black/30 object-contain shadow-2xl md:block"
            />
            <div className="max-w-3xl">
              <p className="mb-5 text-xs font-semibold uppercase tracking-[.22em] text-[#ef796d]">
                {movie.genre} · {movie.year}
              </p>
              <h1 className="break-words font-serif text-[clamp(3rem,15vw,6rem)] leading-[.92] tracking-[-.055em] sm:text-7xl lg:text-8xl">
                {movie.title}
              </h1>
              <p className="mt-5 font-serif text-xl italic text-white/55 sm:text-2xl">
                {movie.tagline}
              </p>
              <div className="mt-7 flex flex-wrap gap-4 text-sm text-white/65">
                <span className="flex items-center gap-1.5">
                  <Star size={15} className="fill-[#ef796d] text-[#ef796d]" />{' '}
                  {movie.rating}
                </span>
                <span className="flex items-center gap-1.5">
                  <Clock3 size={15} />
                  {movie.runtime}
                </span>
                <span className="flex items-center gap-1.5">
                  <Globe2 size={15} />
                  {movie.languages.length} subtitles
                </span>
              </div>
              <p className="mt-7 max-w-2xl leading-7 text-white/65">
                {movie.description}
              </p>
              <div className="mt-8 grid gap-3 min-[430px]:flex min-[430px]:flex-wrap">
                {watchAvailable ? (
                  <a
                    href={`/out/${movie.slug}/watch`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex min-h-12 items-center justify-center gap-2 rounded-full bg-[#ef796d] px-6 py-3.5 text-sm font-semibold"
                  >
                    <Play size={17} fill="currentColor" /> Watch officially
                  </a>
                ) : (
                  <span
                    className="flex min-h-12 cursor-not-allowed items-center justify-center gap-2 rounded-full bg-white/10 px-6 py-3.5 text-sm text-white/45"
                    title="Available only after rights verification"
                  >
                    <Play size={17} /> Official link pending
                  </span>
                )}
                {telegramAvailable ? (
                  <details className="group relative min-[430px]:w-auto">
                    <summary className="flex min-h-12 cursor-pointer list-none items-center justify-center gap-2 rounded-full border border-white/20 px-6 py-3.5 text-sm font-semibold">
                      <Download size={17} /> Download{' '}
                      <ChevronDown
                        size={16}
                        className="transition-transform group-open:rotate-180"
                      />
                    </summary>
                    <div className="absolute inset-x-0 z-10 mt-2 min-w-56 overflow-hidden rounded-2xl border border-white/15 bg-[#242620] p-1 shadow-2xl min-[430px]:right-auto">
                      <a
                        href={`/out/${movie.slug}/telegram`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block rounded-xl px-4 py-3 text-sm hover:bg-white/10"
                      >
                        Download movie
                      </a>
                      {movie.subtitleUrl ? (
                        <a
                          href={movie.subtitleUrl}
                          download
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block rounded-xl px-4 py-3 text-sm hover:bg-white/10"
                        >
                          Download subtitles
                        </a>
                      ) : (
                        <span className="block rounded-xl px-4 py-3 text-sm text-white/40">
                          Subtitles not uploaded
                        </span>
                      )}
                    </div>
                  </details>
                ) : (
                  <span
                    className="flex min-h-12 cursor-not-allowed items-center justify-center gap-2 rounded-full border border-white/10 px-6 py-3.5 text-sm text-white/40"
                    title="Available only after rights verification"
                  >
                    <Download size={17} /> Download pending
                  </span>
                )}
              </div>
              <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-white/35">
                <ShieldCheck size={14} className="mt-0.5 shrink-0" /> External links require current rights
                approval and an active safety switch.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-[1380px] gap-10 px-4 py-12 sm:px-8 sm:py-16 lg:grid-cols-[1fr_1fr] lg:gap-12 lg:px-12">
        <div>
          <p className="section-kicker text-[#ef796d]">Film details</p>
          <dl className="mt-7 divide-y divide-white/10 border-y border-white/10">
            <Detail
              icon={<Film size={16} />}
              label="Release year"
              value={String(movie.year)}
            />
            <Detail
              icon={<Clock3 size={16} />}
              label="Runtime"
              value={movie.runtime}
            />
            <Detail
              icon={<UserRound size={16} />}
              label="Director"
              value={movie.director}
            />
            <Detail
              icon={<Globe2 size={16} />}
              label="Subtitle count"
              value={`${movie.languages.length} languages`}
            />
          </dl>
        </div>
        <div>
          <p className="section-kicker text-[#ef796d]">Available subtitles</p>
          <div className="mt-7 flex flex-wrap gap-2">
            {movie.languages.map((language, index) => (
              <span
                key={language}
                className="rounded-full bg-white/[.07] px-4 py-2.5 text-sm text-white/70"
              >
                <span className="mr-2 text-xs text-white/25">
                  {String(index + 1).padStart(2, '0')}
                </span>
                {language}
              </span>
            ))}
          </div>
          {controls.adsEnabled ? (
            <div className="mt-10 border border-dashed border-white/15 p-6">
              <p className="text-xs font-semibold uppercase tracking-[.2em] text-white/30">
                Advertisement
              </p>
              <p className="mt-4 font-serif text-xl text-white/60">
                A calm space for a privacy-respecting cinema partner.
              </p>
              <p className="mt-2 text-sm leading-6 text-white/30">
                No pop-ups, forced redirects, or misleading download buttons.
              </p>
            </div>
          ) : null}
        </div>
      </section>
      {sourcesAvailable ? (
        <MediaSourcesGateway
          slug={movie.slug}
          title={movie.title}
          streams={movie.streamingSources ?? []}
          downloads={[]}
        />
      ) : null}
      {movie.contentType === 'series' && movie.episodes?.length ? (
        <section className="mx-auto max-w-[1380px] px-5 pb-10 sm:px-8 lg:px-12">
          <p className="section-kicker text-[#ef796d]">Episodes</p>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            {[...movie.episodes]
              .sort((a, b) => a.season - b.season || a.episode - b.episode)
              .map((episode) => (
                <article
                  key={`${episode.season}-${episode.episode}`}
                  className="flex gap-4 rounded-2xl border border-white/10 bg-white/[.035] p-4"
                >
                  <img
                    src={episode.thumbnail || movie.poster}
                    alt=""
                    className="h-24 w-16 rounded-lg object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-white/40">
                      Season {episode.season} · Episode {episode.episode}
                      {episode.rating != null ? ` · ★ ${episode.rating}` : ''}
                    </p>
                    <p className="mt-1 text-sm font-semibold">
                      {episode.title}
                    </p>
                    {episode.description ? (
                      <p className="mt-1 line-clamp-2 text-xs text-white/50">
                        {episode.description}
                      </p>
                    ) : null}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {episode.downloadSources?.length &&
                      episode.downloadStatus !== 'pending' ? (
                        <a
                          href={`/download/${movie.slug}/s${String(episode.season).padStart(2, '0')}e${String(episode.episode).padStart(2, '0')}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded-full bg-[#ef796d] px-3 py-2 text-xs font-semibold"
                        >
                          <Download size={13} className="mr-1 inline" />
                          Download
                        </a>
                      ) : (
                        <span className="rounded-full bg-white/10 px-3 py-2 text-xs text-white/40">
                          Download pending
                        </span>
                      )}
                      {episode.url &&
                      movie.rightsStatus === 'verified' &&
                      controls.externalLinksEnabled ? (
                        <a
                          href={episode.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded-full border border-white/20 px-3 py-2 text-xs font-semibold"
                        >
                          Watch
                        </a>
                      ) : null}
                    </div>
                  </div>
                </article>
              ))}
          </div>
        </section>
      ) : null}
      <div className="mx-auto flex max-w-[1380px] flex-wrap items-center gap-4 px-5 pb-8 sm:px-8 lg:px-12">
        {movie.officialWatchUrl ? (
          <TrailerModal url={movie.officialWatchUrl} title={movie.title} />
        ) : null}
        <ShareButtons
          title={movie.title}
          path={`/${movie.contentType === 'series' ? 'series' : 'movie'}/${movie.slug}`}
        />
      </div>
      <CastList cast={movie.cast} />
      <PendingDownloadRedirect
        href={`/download/${movie.slug}`}
        active={movie.downloadStatus !== 'pending'}
      />
      <MovieComments slug={movie.slug} />
    </main>
  );
}

function Detail({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="grid grid-cols-[24px_1fr_auto] items-center gap-3 py-4 text-sm">
      <span className="text-[#ef796d]">{icon}</span>
      <dt className="text-white/40">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
