import { badRequest, HttpError, httpRequest } from '@haunted-lab/common';
import { commitDiff, commitInfo, isAncestor, resolveCommit } from './git.ts';
import { ALLOW_LIST } from './refs.ts';
import { isServiceName, SERVICES, type DeployRecord, type ErrorItem, type LogItem, type ServiceName } from './types.ts';
import { cleanDiff, cleanField, UNTRUSTED } from './untrusted.ts';

export { repoRelative } from './untrusted.ts';

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;
export const LIST_CAP_BYTES = 256 * 1024;
export const DIFF_CAP_BYTES = 64 * 1024;

export interface LabQuery {
  service?: ServiceName;
  since?: Date;
  limit: number;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Total parser: returns a valid query or throws a 400 `bad_request` HttpError. Never anything else. */
export function parseLabQuery(query: URLSearchParams, allowed: readonly ('service' | 'since' | 'limit')[] = ['service', 'since', 'limit']): LabQuery {
  for (const key of new Set(query.keys())) {
    if (!(allowed as readonly string[]).includes(key)) throw badRequest(`unknown parameter ${key.slice(0, 32)}`);
    if (query.getAll(key).length > 1) throw badRequest(`parameter ${key} given more than once`);
  }
  const out: LabQuery = { limit: DEFAULT_LIMIT };
  const service = query.get('service');
  if (service !== null) {
    if (!isServiceName(service)) throw badRequest('service must be one of gate, orders, payments, ledger');
    out.service = service;
  }
  const since = query.get('since');
  if (since !== null) {
    const t = Date.parse(since);
    if (!ISO.test(since) || Number.isNaN(t)) throw badRequest('since must be an ISO-8601 time');
    out.since = new Date(t);
  }
  const limit = query.get('limit');
  if (limit !== null) {
    if (!/^\d{1,4}$/.test(limit)) throw badRequest('limit must be an integer');
    const n = Number(limit);
    if (n < 1 || n > MAX_LIMIT) throw badRequest(`limit must be between 1 and ${MAX_LIMIT}`);
    out.limit = n;
  }
  return out;
}

/**
 * Keep the newest items whose JSON envelope `{ untrusted, items, truncated }` fits in `cap` bytes.
 * Items stay in order (oldest first); `truncated` is true iff items were dropped.
 */
export function capList<T>(items: readonly T[], cap: number = LIST_CAP_BYTES): { untrusted: true; items: T[]; truncated: boolean } {
  const envelope = Buffer.byteLength('{"untrusted":true,"items":[],"truncated":false}');
  let size = envelope;
  let start = items.length;
  while (start > 0) {
    const item = items[start - 1];
    const add = Buffer.byteLength(JSON.stringify(item)) + (start === items.length ? 0 : 1);
    if (size + add > cap) break;
    size += add;
    start--;
  }
  return { ...UNTRUSTED, items: items.slice(start), truncated: start > 0 };
}

/** Cut a UTF-8 buffer to at most `cap` bytes without splitting a character. */
export function capText(buf: Buffer, cap: number = DIFF_CAP_BYTES): { text: string; truncated: boolean; bytes: number } {
  if (buf.length <= cap) return { text: buf.toString('utf8'), truncated: false, bytes: buf.length };
  let end = cap;
  // Step back over continuation bytes (10xxxxxx) so the cut lands on a character boundary.
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true, bytes: end };
}

const byTime = <T extends { time: string }>(a: T, b: T) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0);

export function selectItems<T extends { time: string; service?: ServiceName }>(items: T[], q: LabQuery): T[] {
  const since = q.since?.toISOString();
  const filtered = items.filter((i) => (!q.service || i.service === q.service) && (!since || i.time > since));
  filtered.sort(byTime);
  return filtered.slice(Math.max(0, filtered.length - q.limit));
}

export interface ObservabilityDeps {
  repo: string;
  /** host:port per service for /debug/errors */
  serviceBase(service: ServiceName): string;
  exits(service: ServiceName): ErrorItem[];
  logs(service: ServiceName): LogItem[];
  /** In-memory tail of the deploy log (no file read per request). */
  deploys(): DeployRecord[];
  resolveRef(ref: string): Promise<string | undefined>;
  /** Heads of the incident refs fetched into the mirror (fix commits are served too). */
  incidentTips?(): Promise<string[]>;
}

const cleanError = (e: ErrorItem): ErrorItem => ({
  time: cleanField(e.time, 'time'),
  service: e.service,
  message: cleanField(e.message, 'message'),
  frame: cleanField(e.frame, 'frame'),
  requestId: cleanField(e.requestId, 'requestId'),
  source: e.source,
});

const cleanLog = (l: LogItem): LogItem => ({ time: cleanField(l.time, 'time'), service: l.service, stream: l.stream, line: cleanField(l.line, 'line') });

const cleanDeploy = (d: DeployRecord): DeployRecord => ({ ...d, ref: cleanField(d.ref, 'ref') });

async function serviceErrors(deps: ObservabilityDeps, service: ServiceName): Promise<ErrorItem[]> {
  try {
    const res = await httpRequest(`${deps.serviceBase(service)}/debug/errors?limit=200`, { timeoutMs: 1000 });
    if (res.status !== 200) return [];
    const body = JSON.parse(res.text) as { items?: unknown };
    if (!Array.isArray(body.items)) return [];
    return body.items.map((raw: Record<string, unknown>) => cleanError({ ...raw, service, source: 'service' } as ErrorItem));
  } catch {
    return []; // service down: the supervisor's exit events still show it
  }
}

export async function listErrors(deps: ObservabilityDeps, q: LabQuery) {
  const services = q.service ? [q.service] : [...SERVICES];
  const exits = (s: ServiceName) => deps.exits(s).map(cleanError);
  const all = (await Promise.all(services.map(async (s) => [...(await serviceErrors(deps, s)), ...exits(s)]))).flat();
  return capList(selectItems(all, q));
}

export function listLogs(deps: ObservabilityDeps, q: LabQuery) {
  const services = q.service ? [q.service] : [...SERVICES];
  const items = services.flatMap((s) => deps.logs(s).map(cleanLog));
  return capList(selectItems(items, q));
}

export function listDeploys(deps: ObservabilityDeps, q: LabQuery) {
  const since = q.since?.toISOString();
  const all = deps.deploys().filter((d) => !since || d.time > since);
  return capList(all.slice(Math.max(0, all.length - MAX_LIMIT)).map(cleanDeploy));
}

export const unknownCommit = (): HttpError => new HttpError(404, 'unknown_commit', 'unknown commit');

/** The commit's full sha if `hex` names a commit reachable from a named ref or a fetched incident ref, else undefined. */
export async function reachableCommit(deps: Pick<ObservabilityDeps, 'repo' | 'resolveRef' | 'incidentTips'>, hex: string): Promise<string | undefined> {
  // Upper-case hex is accepted and normalised; anything else is not a commit name.
  const lower = hex.toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(lower)) return undefined;
  const sha = await resolveCommit(deps.repo, lower);
  if (!sha) return undefined;
  const tips: string[] = [];
  for (const ref of ALLOW_LIST) {
    const tip = await deps.resolveRef(ref);
    if (tip) tips.push(tip);
  }
  if (deps.incidentTips) tips.push(...(await deps.incidentTips()));
  for (const tip of new Set(tips)) {
    if (tip === sha || (await isAncestor(deps.repo, sha, tip))) return sha;
  }
  return undefined;
}

export async function commitWithDiff(deps: ObservabilityDeps, hex: string) {
  if (!/^[0-9A-Fa-f]{7,40}$/.test(hex)) throw unknownCommit();
  const sha = await reachableCommit(deps, hex);
  if (!sha) throw unknownCommit();
  const info = await commitInfo(deps.repo, sha);
  const raw = await commitDiff(deps.repo, sha, DIFF_CAP_BYTES);
  const capped = capText(raw.diff, DIFF_CAP_BYTES);
  const diff = cleanDiff(capped.text);
  return {
    ...UNTRUSTED,
    sha: info.sha,
    subject: cleanField(info.subject, 'subject'),
    author: cleanField(info.author, 'author'),
    date: cleanField(info.date, 'time'),
    diff,
    truncated: raw.truncated || capped.truncated,
    bytes: Buffer.byteLength(diff),
  };
}
