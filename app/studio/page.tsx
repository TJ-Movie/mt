import type { Metadata } from 'next';
import { ShieldCheck } from 'lucide-react';
import { MovieStudio } from '../../components/admin/movie-studio';
import { SourceGovernance } from '../../components/admin/source-governance';
import {
  initializeStarterCatalogue,
  listAdminMovies,
  listApprovedDomains,
  listAuditEvents,
  listSourceReports,
} from '../../db';
import { requireAdminUser } from '../../lib/security/admin-auth';
import { getRuntimeControls } from '../../lib/security/runtime-controls';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Flixlyra Studio',
  robots: { index: false, follow: false, nocache: true },
};

export default async function StudioPage() {
  const user = await requireAdminUser('/studio');
  await initializeStarterCatalogue(user);
  const [movies, auditEvents, domains, reports] = await Promise.all([
    listAdminMovies(),
    listAuditEvents(),
    listApprovedDomains(),
    listSourceReports(),
  ]);
  const controls = getRuntimeControls();

  return (
    <main className="min-h-screen bg-[#111310] text-[#f2efe9]">
      <header className="border-b border-white/10 bg-[#151714]">
        <div className="mx-auto flex max-w-[1500px] flex-col gap-5 px-4 py-6 sm:px-8 md:flex-row md:items-center md:justify-between lg:px-12">
          <div>
            <div className="flex items-center gap-3">
              <ShieldCheck className="text-[#ef796d]" />
              <p className="font-serif text-3xl">Flixlyra Studio</p>
            </div>
            <p className="mt-2 text-sm text-white/45">
              Private catalogue, rights and delivery control
            </p>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-4 text-sm">
            <span className="max-w-56 truncate text-white/50">
              {user.email}
            </span>
            <a
              href="/cdn-cgi/access/logout"
              target="_top"
              className="rounded-full border border-white/15 px-4 py-2 hover:border-white/35"
            >
              Sign out
            </a>
          </div>
        </div>
      </header>
      <MovieStudio
        initialMovies={movies}
        initialAuditEvents={auditEvents}
        controls={controls}
      />
      <div className="mx-auto max-w-[1500px] px-4 pb-12 sm:px-8 lg:px-12">
        <SourceGovernance initialDomains={domains} initialReports={reports} />
      </div>
    </main>
  );
}
