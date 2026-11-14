import { ConfigError } from '@haunted-lab/common';

export const DEFAULT_ORIGIN_URL = 'https://github.com/Akar-Samudra-Artifisial/Haunted-Lab.git';

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * `LAB_ORIGIN_URL`: a plain public https URL (host name, not an IP; no user, password, query or
 * fragment). With `allowFile` (tests only) also an absolute `file:///...` URL. Errors name the
 * variable only, never the value.
 */
export function parseOriginUrl(value: string, allowFile = false): string {
  const invalid = () => new ConfigError([], ['LAB_ORIGIN_URL']);
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (typeof value !== 'string' || value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) throw invalid();
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw invalid();
  }
  if (u.username || u.password || u.search || u.hash || value.includes('?') || value.includes('#')) throw invalid();
  if (u.protocol === 'https:') {
    const host = u.hostname;
    if (host === '' || host.startsWith('[') || IPV4.test(host) || !host.includes('.')) throw invalid();
    return u.href;
  }
  if (allowFile && u.protocol === 'file:' && u.host === '' && u.pathname.startsWith('/') && u.pathname.length > 1) return u.href;
  throw invalid();
}
