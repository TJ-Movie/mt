'use client';
import { useState } from 'react';
import { Plus, ShieldCheck, Trash2 } from 'lucide-react';
import type { ApprovedDomain, SourceReport } from '../../db';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
export function SourceGovernance({
  initialDomains,
  initialReports,
}: {
  initialDomains: ApprovedDomain[];
  initialReports: SourceReport[];
}) {
  const [domains, setDomains] = useState(initialDomains);
  const [reports, setReports] = useState(initialReports);
  const [domain, setDomain] = useState('');
  const [message, setMessage] = useState('');
  async function add() {
    const r = await fetch('/api/admin/domains', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sublyra-Action': 'admin-write',
      },
      body: JSON.stringify({ domain }),
    });
    const data = (await r.json()) as {
      error?: string;
      created?: number;
      total?: number;
    };
    if (!r.ok) {
      setMessage(data.error ?? 'Could not add domains.');
      return;
    }
    setMessage(
      `${data.created ?? 0} domain${data.created === 1 ? '' : 's'} added.`,
    );
    location.reload();
  }
  async function remove(id: number) {
    const r = await fetch(`/api/admin/domains/${id}`, {
      method: 'DELETE',
      headers: { 'X-Sublyra-Action': 'admin-write' },
    });
    if (r.ok) setDomains((items) => items.filter((item) => item.id !== id));
  }
  async function resolve(id: number, action: 'disabled' | 'dismissed') {
    const r = await fetch(`/api/admin/reports/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Sublyra-Action': 'admin-write',
      },
      body: JSON.stringify({ action }),
    });
    if (r.ok) setReports((items) => items.filter((item) => item.id !== id));
  }
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <section className="rounded-2xl border border-white/10 bg-white/[.035] p-5">
        <h2 className="flex items-center gap-2 font-serif text-2xl">
          <ShieldCheck className="text-[#ef796d]" />
          Approved domains
        </h2>
        <p className="mt-2 text-sm text-white/45">
          Only exact HTTPS hostnames in this registry can be saved as player or
          download sources. Add one or several, separated by commas or new
          lines.
        </p>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <Input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="doodstream.com, pixeldrain.com"
          />
          <Button onClick={add} className="bg-[#ef796d] text-white">
            <Plus />
            Add
          </Button>
        </div>
        {message && <p className="mt-3 text-sm text-white/60">{message}</p>}
        <div className="mt-5 space-y-2">
          {domains.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between rounded-xl border border-white/10 px-4 py-3"
            >
              <span>{item.domain}</span>
              <Button
                variant="ghost"
                onClick={() => remove(item.id)}
                aria-label={`Remove ${item.domain}`}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      </section>
      <section className="rounded-2xl border border-white/10 bg-white/[.035] p-5">
        <h2 className="font-serif text-2xl">Open source reports</h2>
        <div className="mt-5 space-y-3">
          {reports.length === 0 ? (
            <p className="text-sm text-white/40">No open reports.</p>
          ) : (
            reports.map((report) => (
              <article
                key={report.id}
                className="rounded-xl border border-white/10 p-4"
              >
                <div className="flex justify-between gap-3">
                  <div>
                    <p className="font-semibold">
                      {report.movieSlug} · {report.sourceLabel}
                    </p>
                    <p className="mt-1 text-sm text-white/50">
                      {report.reason}
                    </p>
                    <p className="mt-1 break-all text-xs text-white/30">
                      {report.sourceUrl}
                    </p>
                  </div>
                  <span className="text-xs uppercase text-[#ef796d]">
                    {report.sourceKind}
                  </span>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    variant="destructive"
                    onClick={() => resolve(report.id, 'disabled')}
                  >
                    Disable source
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => resolve(report.id, 'dismissed')}
                  >
                    Dismiss
                  </Button>
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
