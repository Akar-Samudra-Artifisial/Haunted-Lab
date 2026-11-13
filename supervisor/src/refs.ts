/** The only refs the supervisor may deploy. */
export const ALLOW_LIST: readonly string[] = Object.freeze(['main', 'scenario/error-spike', 'scenario/fog', 'scenario/dark-room']);

export type RefClass = 'allowed' | 'reserved' | 'denied';

const RESERVED = /^exorcist\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** `exorcist/*` fix branches are recognised but refused until a later spec enables them. */
export function classifyRef(ref: unknown): RefClass {
  if (typeof ref !== 'string') return 'denied';
  if (ALLOW_LIST.includes(ref)) return 'allowed';
  if (RESERVED.test(ref) && !ref.includes('..')) return 'reserved';
  return 'denied';
}
