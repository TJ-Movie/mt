import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';

export function InfoPage({
  eyebrow,
  title,
  intro,
  children,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <main className="min-h-screen bg-[#f2efe9] text-[#181916]">
      <header className="border-b border-black/10">
        <div className="mx-auto flex min-h-16 max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:h-20 sm:px-8 sm:py-0">
          <a
            href="/"
            className="font-serif text-xl font-semibold tracking-[-.04em] sm:text-2xl"
          >
            Flixlyra<span className="text-[#b43a2e]">.</span>
          </a>
          <a
            href="/"
            className="flex min-h-11 items-center gap-2 text-sm text-black/55 hover:text-black"
          >
            <ArrowLeft size={15} /> Back to films
          </a>
        </div>
      </header>
      <article className="mx-auto max-w-5xl px-4 py-12 sm:px-8 sm:py-24">
        <p className="section-kicker">{eyebrow}</p>
        <h1 className="mt-5 max-w-3xl break-words font-serif text-4xl leading-[.98] tracking-[-.04em] sm:text-7xl">
          {title}
        </h1>
        <p className="mt-6 max-w-2xl text-base leading-7 text-black/55 sm:mt-7 sm:text-lg sm:leading-8">
          {intro}
        </p>
        <div className="info-content mt-10 max-w-3xl border-t border-black/15 pt-8 sm:mt-14 sm:pt-10">
          {children}
        </div>
      </article>
      <footer className="border-t border-black/10 px-5 py-7 text-center text-sm text-black/40">
        © 2026 Flixlyra · One film. Many languages.
      </footer>
    </main>
  );
}

export function InfoSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h2 className="font-serif text-3xl tracking-[-.02em]">{title}</h2>
      <div className="mt-4 space-y-4 text-base leading-7 text-black/60">
        {children}
      </div>
    </section>
  );
}
