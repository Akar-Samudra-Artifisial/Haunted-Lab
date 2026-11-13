import { createHash, timingSafeEqual } from 'node:crypto';

const PREFIX = 'Bearer ';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** True iff header is `Bearer <secret>`. Compared in constant time over SHA-256 digests. */
export function bearerMatches(header: string | undefined, secret: string): boolean {
  const given = typeof header === 'string' && header.startsWith(PREFIX) ? header.slice(PREFIX.length) : '';
  const same = timingSafeEqual(digest(given), digest(secret));
  return same && secret.length > 0 && typeof header === 'string' && header.startsWith(PREFIX);
}
