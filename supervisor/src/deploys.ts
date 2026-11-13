import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Ring } from '@haunted-lab/common';
import { isServiceName, type DeployRecord } from './types.ts';

export const FIRST_DEPLOY_ID = 101;
/** Records kept in memory for `/lab/deploys` (the file keeps everything). */
export const DEPLOY_TAIL = 1000;

const ID = /^d-(\d{1,12})$/;

function parseRecord(line: string): DeployRecord | undefined {
  try {
    const r = JSON.parse(line) as Partial<DeployRecord>;
    if (
      typeof r.id === 'string' &&
      ID.test(r.id) &&
      isServiceName(r.service) &&
      typeof r.ref === 'string' &&
      typeof r.sha === 'string' &&
      typeof r.time === 'string' &&
      (r.actor === 'supervisor' || r.actor === 'chaos' || r.actor === 'exorcist')
    ) {
      return { id: r.id, service: r.service, ref: r.ref, sha: r.sha, time: r.time, actor: r.actor };
    }
  } catch {
    // skip malformed line
  }
  return undefined;
}

const idNumber = (id: string): number => Number(ID.exec(id)?.[1] ?? '0');

/** Read and parse a whole deploy log file (used once at open). */
export async function readDeployFile(file: string): Promise<DeployRecord[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out: DeployRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const r = parseRecord(line);
    if (r) out.push(r);
  }
  return out;
}

/**
 * Append-only JSON Lines deploy log (`data/deploys.jsonl`). Never rewritten or truncated.
 * The file is read once at open; afterwards a bounded in-memory tail serves reads.
 */
export class DeployLog {
  readonly file: string;
  #next = FIRST_DEPLOY_ID;
  #queue: Promise<unknown> = Promise.resolve();
  #tail: Ring<DeployRecord>;

  private constructor(file: string, tailSize: number) {
    this.file = file;
    this.#tail = new Ring<DeployRecord>(tailSize);
  }

  static async open(file: string, tailSize: number = DEPLOY_TAIL): Promise<DeployLog> {
    const log = new DeployLog(file, tailSize);
    await mkdir(dirname(file), { recursive: true });
    const all = await readDeployFile(file);
    const max = all.reduce((m, r) => Math.max(m, idNumber(r.id)), FIRST_DEPLOY_ID - 1);
    log.#next = max + 1;
    for (const r of all) log.#tail.push(r);
    return log;
  }

  /** Newest records (at most the tail size), oldest first. No file access. */
  records(): DeployRecord[] {
    return this.#tail.latest();
  }

  /** Assign the next id and append. Calls are serialized so ids stay strictly increasing. */
  append(record: Omit<DeployRecord, 'id'>): Promise<DeployRecord> {
    const run = async () => {
      const full: DeployRecord = { id: `d-${this.#next}`, ...record };
      await appendFile(this.file, `${JSON.stringify(full)}\n`, { flag: 'a', encoding: 'utf8' });
      this.#next++;
      this.#tail.push(full);
      return full;
    };
    const p = this.#queue.then(run, run);
    this.#queue = p.catch(() => undefined);
    return p;
  }
}
