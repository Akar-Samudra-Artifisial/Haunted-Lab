// Text served by /lab comes from services, child processes and commits. It is untrusted input for
// the Exorcist agent: it may contain anything a broken (or hostile) service prints. Before it leaves
// the supervisor it is bounded, stripped of terminal escapes and control characters, and stripped
// of local absolute paths. Consumers must treat it as data, never as instructions.

/** Per-field length caps (characters) for untrusted text fields. */
export const FIELD_CAPS = Object.freeze({
  message: 500,
  line: 2000,
  frame: 300,
  subject: 300,
  author: 200,
  ref: 200,
  requestId: 64,
  time: 40,
});

export type UntrustedField = keyof typeof FIELD_CAPS;

/* eslint-disable no-control-regex -- matching control characters is the point here */
// CSI (ESC [ ... final), OSC (ESC ] ... BEL | ESC \), other two-char escapes, and 8-bit CSI.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]|\x9b[0-?]*[ -/]*[@-~]/g;
// C0 (except TAB/LF), DEL and C1 controls; CR removed too.
const CONTROLS_KEEP_LINES = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
// Everything above plus TAB and LF, for single-line fields.
const CONTROLS_ALL = /[\x00-\x1f\x7f-\x9f]/g;
/* eslint-enable no-control-regex */

/** Remove ANSI escapes and control characters. `keepLines` keeps `\n` and `\t` (for diffs). */
export function stripControls(text: string, keepLines = false): string {
  const noAnsi = text.replace(ANSI, '');
  return keepLines ? noAnsi.replace(CONTROLS_KEEP_LINES, '') : noAnsi.replace(CONTROLS_ALL, ' ');
}

// An absolute path token (optionally a file:// URL). ':' ends the token so `:line:col` survives.
const ABS_PATH = /(?:file:\/\/)?\/[^\s()'"`<>:,;]+/g;
const FS_ROOT = /^\/(?:Users|home|private|tmp|var|opt|root|srv|mnt|Volumes|usr|etc|proc|nix|snap|workspace|app|data)\//;
const FILE_EXT = /\.(?:[cm]?[jt]sx?|json|node|map)$/;

function rewritePath(token: string): string {
  const path = token.startsWith('file://') ? token.slice('file://'.length) : token;
  const isFsPath = token.startsWith('file://') || FS_ROOT.test(path) || FILE_EXT.test(path) || /\/(?:node_modules|services|packages)\//.test(path);
  if (!isFsPath) return token; // e.g. a route like /checkout
  const nm = path.lastIndexOf('/node_modules/');
  if (nm !== -1) return path.slice(nm + 1);
  const repo = /\/((?:services|packages)\/[^/]+\/.*)$/.exec(path);
  if (repo?.[1]) return repo[1];
  return path.slice(path.lastIndexOf('/') + 1) || '';
}

/**
 * Strip every local absolute path: repo files become repo-relative (`services/payments/src/x.ts`),
 * dependency files become `node_modules/<pkg>/...`, anything else keeps only its file name.
 */
export const stripPaths = (text: string): string => text.replace(ABS_PATH, rewritePath);

/** Back-compat name used by tests and callers. */
export const repoRelative = stripPaths;

/** Bound first (so the regexes only ever see a bounded string), then strip, then cap. */
export function cleanField(value: unknown, field: UntrustedField): string {
  if (typeof value !== 'string') return '';
  const cap = FIELD_CAPS[field];
  const bounded = value.slice(0, cap * 4);
  return stripControls(stripPaths(bounded)).slice(0, cap);
}

/** Diffs keep their lines and tabs; escapes and other controls go. Size is capped separately. */
export const cleanDiff = (diff: string): string => stripControls(diff, true);

/** Marker on every /lab response body. */
export const UNTRUSTED = Object.freeze({ untrusted: true as const });
