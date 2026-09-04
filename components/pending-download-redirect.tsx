'use client';
import { useEffect } from 'react';

export function PendingDownloadRedirect({ href }: { href: string }) {
  useEffect(() => {
    const targets = [...document.querySelectorAll<HTMLElement>('span')].filter((node) => node.textContent?.trim() === 'Download pending');
    const onClick = () => { window.open(href, '_blank', 'noopener,noreferrer'); };
    targets.forEach((node) => { node.textContent = 'Download'; node.classList.add('cursor-pointer', 'rounded-full', 'border', 'border-white/20', 'px-6', 'py-3.5', 'text-sm', 'font-semibold', 'text-white', 'hover:border-white/40'); node.removeAttribute('title'); node.setAttribute('role', 'link'); node.setAttribute('tabindex', '0'); node.addEventListener('click', onClick); node.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(); } }); });
    return () => targets.forEach((node) => node.removeEventListener('click', onClick));
  }, [href]);
  return null;
}
