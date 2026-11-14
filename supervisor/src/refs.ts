import { INCIDENT_REF } from './fix-contract.ts';

/** Refs deployable by name (boot, apply, reset). */
export const ALLOW_LIST: readonly string[] = Object.freeze(['main', 'scenario/error-spike', 'scenario/fog', 'scenario/dark-room']);

/**
 * `named`: `main` and the three scenario branches.
 * `fix`: `incident/<cuid>`, deployable only through `POST /chaos/deploy-fix`.
 * `denied`: everything else, including `exorcist/*`.
 */
export type RefClass = 'named' | 'fix' | 'denied';

export function classifyRef(ref: unknown): RefClass {
  if (typeof ref !== 'string') return 'denied';
  if (ALLOW_LIST.includes(ref)) return 'named';
  if (INCIDENT_REF.test(ref)) return 'fix';
  return 'denied';
}
