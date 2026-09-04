'use client';
import { useEffect } from 'react';

export function PendingDownloadRedirect({ href }: { href: string }) {
  useEffect(() => {
    const targets = [...document.querySelectorAll<HTMLElement>('span')].filter((node) => node.textContent?.trim() === 'Download pending');
    const onClick = () => { window.open(href, '_blank', 'noopener,noreferrer'); };
    targets.forEach((node) => { node.classList.add('cursor-pointer'); node.setAttribute('role', 'link'); node.setAttribute('tabindex', '0'); node.addEventListener('click', onClick); node.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(); } }); });
    return () => targets.forEach((node) => node.removeEventListener('click', onClick));
  }, [href]);
  return null;
}
