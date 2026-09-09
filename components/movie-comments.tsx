'use client';

import { FormEvent, useEffect, useState } from 'react';

type Comment = { id: number; name: string; body: string; createdAt: string };

export function MovieComments({ slug }: { slug: string }) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/movies/${encodeURIComponent(slug)}/comments`, {
      credentials: 'same-origin',
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { comments?: Comment[] } | null) =>
        setComments(data?.comments ?? []),
      )
      .catch(() => undefined);
  }, [slug]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus('');
    const response = await fetch(
      `/api/movies/${encodeURIComponent(slug)}/comments`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, body, website: '' }),
      },
    ).catch(() => null);
    const result = response
      ? ((await response.json().catch(() => ({}))) as { error?: string })
      : {};
    if (!response?.ok)
      setStatus(result.error ?? 'Could not post your comment.');
    else {
      setStatus('Thanks — your feedback was added.');
      setName('');
      setBody('');
      const refreshed = (await fetch(
        `/api/movies/${encodeURIComponent(slug)}/comments`,
      )
        .then((res) => res.json())
        .catch(() => null)) as { comments?: Comment[] } | null;
      setComments(refreshed?.comments ?? comments);
    }
    setBusy(false);
  }

  return (
    <section className="mx-auto max-w-[1380px] border-t border-white/10 px-4 py-12 sm:px-8 sm:py-16 lg:px-12">
      <div className="grid gap-10 lg:grid-cols-[.8fr_1.2fr]">
        <div>
          <p className="section-kicker text-[#ef796d]">Community notes</p>
          <h2 className="mt-3 font-serif text-3xl sm:text-4xl">What did you think?</h2>
          <p className="mt-3 max-w-md text-sm leading-6 text-white/45">
            Share a short, respectful review. Please do not post private links
            or personal information.
          </p>
          <form onSubmit={submit} className="mt-7 space-y-3">
            <input
              required
              maxLength={40}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Your name"
              className="h-11 w-full rounded-xl border border-white/15 bg-white/[.04] px-4 text-sm text-white outline-none placeholder:text-white/30"
            />
            <textarea
              required
              maxLength={500}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Write your feedback..."
              className="min-h-28 w-full rounded-xl border border-white/15 bg-white/[.04] p-4 text-sm text-white outline-none placeholder:text-white/30"
            />
            <button
              disabled={busy}
              className="min-h-12 rounded-full bg-[#ef796d] px-5 py-3 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? 'Posting…' : 'Post feedback'}
            </button>
            {status ? (
              <p role="status" className="text-sm text-white/55">
                {status}
              </p>
            ) : null}
          </form>
        </div>
        <div className="space-y-3">
          {comments.length ? (
            comments.map((comment) => (
              <article
                key={comment.id}
                className="rounded-2xl border border-white/10 bg-white/[.035] p-5"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="font-semibold">{comment.name}</p>
                  <time className="text-xs text-white/35">
                    {new Date(comment.createdAt).toLocaleDateString()}
                  </time>
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-white/60">
                  {comment.body}
                </p>
              </article>
            ))
          ) : (
            <div className="rounded-2xl border border-dashed border-white/15 p-8 text-sm text-white/40">
              Be the first to leave feedback.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
