'use client';

import { useEffect, useState } from 'react';

const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const EVENTS: (keyof WindowEventMap)[] = ['mousemove', 'keydown', 'click', 'scroll'];

export function AdminSessionGuard({ children }: { children: React.ReactNode }) {
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    let timer: number | undefined;
    const reset = () => {
      if (locked) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        sessionStorage.removeItem('flixlyra-admin-session');
        setLocked(true);
        window.location.assign('/cdn-cgi/access/logout');
      }, IDLE_TIMEOUT_MS);
    };
    EVENTS.forEach((event) => window.addEventListener(event, reset, { passive: true }));
    reset();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      EVENTS.forEach((event) => window.removeEventListener(event, reset));
    };
  }, [locked]);

  if (!locked) return <>{children}</>;
  return <main className="flex min-h-screen items-center justify-center bg-[#111310] p-6 text-[#f2efe9]"><div className="rounded-2xl border border-white/10 bg-white/[.04] p-8 text-center"><h1 className="text-2xl font-semibold">Studio locked</h1><p className="mt-2 text-white/55">Your session was signed out after 15 minutes of inactivity.</p><a className="mt-6 inline-block rounded-full bg-[#ef796d] px-5 py-3 font-semibold text-white" href="/studio">Sign in again</a></div></main>;
}
