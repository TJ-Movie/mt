const YTS_IMAGE_HOSTS = new Set(['yts.mx', 'yts.lt', 'yts.am', 'yts.rs', 'yts.pm']);

export function approvedImageSource(value, options = {}) {
  const maxLength = Number.isSafeInteger(options.maxLength) && options.maxLength > 0 ? options.maxLength : 2000;
  const candidate = typeof value === 'string' ? value.normalize('NFKC').trim().slice(0, maxLength) : '';
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    const allowYtsSubdomains = options.allowYtsSubdomains === true;
    const ytsHost = hostname === 'yts.gg' || YTS_IMAGE_HOSTS.has(hostname) ||
      (allowYtsSubdomains && [...YTS_IMAGE_HOSTS].some((host) => hostname.endsWith('.' + host)));
    const allowedHost = hostname === 'image.tmdb.org' || ytsHost;
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && allowedHost
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
