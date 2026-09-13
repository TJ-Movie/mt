import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/admin', '/api/', '/studio'],
      },
      {
        userAgent: [
          'GPTBot',
          'ChatGPT-User',
          'PerplexityBot',
          'ClaudeBot',
          'Google-Extended',
          'Bytespider',
          'Applebot-Extended',
        ],
        allow: ['/', '/movie/', '/movies', '/series/'],
        disallow: ['/admin', '/api/', '/studio'],
      },
    ],
    sitemap: 'https://flixlyra.com/sitemap.xml',
  };
}
