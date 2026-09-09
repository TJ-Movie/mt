'use client';

import { RotateCcw } from 'lucide-react';

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="grid min-h-screen place-items-center bg-[#171815] px-5 text-center text-white">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[.22em] text-[#ef796d]">
          Playback interrupted
        </p>
        <h1 className="mt-4 font-serif text-4xl tracking-[-.04em] sm:text-5xl">
          Flixlyra could not load this scene.
        </h1>
        <p className="mx-auto mt-4 max-w-lg text-base leading-7 text-white/50">
          Try again. If the problem continues, return to the movie collection.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <button
            onClick={reset}
              className="flex min-h-12 items-center gap-2 rounded-full bg-[#ef796d] px-5 py-3 text-sm font-semibold"
          >
            <RotateCcw size={15} /> Try again
          </button>
          <a
            href="/"
              className="flex min-h-12 items-center rounded-full border border-white/15 px-5 py-3 text-sm"
          >
            Go home
          </a>
        </div>
      </div>
    </main>
  );
}
