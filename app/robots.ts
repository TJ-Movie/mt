import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots { return { rules: { userAgent: '*', allow: '/', disallow: ['/api/', '/out/', '/studio'] }, sitemap: 'https://flixlyra.com/sitemap.xml' }; }
