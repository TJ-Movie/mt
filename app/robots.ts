import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots { return { rules: { userAgent: '*', allow: '/', disallow: ['/api/', '/out/'] }, sitemap: 'https://sublyra-cinema.alive-stoat-6821.chatgpt.site/sitemap.xml' }; }
