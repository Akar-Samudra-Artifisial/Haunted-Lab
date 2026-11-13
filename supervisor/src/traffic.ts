import { randomInt } from 'node:crypto';
import { httpRequest } from '@haunted-lab/common';

export const MAX_IN_FLIGHT = 50;
export const JITTER = 0.4;

/** Inter-arrival time in ms: base 1000/rps, jittered uniformly within ±40%. `rand` is in [0, 1). */
export function nextInterval(rps: number, rand: number): number {
  const base = 1000 / rps;
  const r = Math.min(Math.max(rand, 0), 1);
  return base * (1 - JITTER + 2 * JITTER * r);
}

const SKUS = ['lantern', 'candle', 'rope', 'chalk', 'bell', 'mirror'];

/** Synthetic checkout body. Order ids are random so ~30% hit the refund buckets with no record. */
export function syntheticOrder(seq: number): { orderId: string; sku: string; qty: number; amountCents: number } {
  return {
    orderId: `o-${seq}-${randomInt(1_000_000)}`,
    sku: SKUS[seq % SKUS.length] as string,
    qty: 1 + (seq % 3),
    amountCents: 100 + randomInt(9_900),
  };
}

export interface TrafficOptions {
  /** Base URL of gate. The generator targets only `${gateUrl}/checkout`. */
  gateUrl: string;
  rps: number;
  maxInFlight?: number;
  rand?: () => number;
  send?: (body: unknown) => Promise<unknown>;
}

/** Steady synthetic load on gate. Never throws; skips a tick instead of queueing when saturated. */
export class TrafficGenerator {
  #opts: TrafficOptions;
  #timer: NodeJS.Timeout | undefined;
  #seq = 0;
  inFlight = 0;
  peakInFlight = 0;
  sent = 0;
  skipped = 0;
  failed = 0;

  constructor(opts: TrafficOptions) {
    this.#opts = opts;
  }

  #send(body: unknown): Promise<unknown> {
    if (this.#opts.send) return this.#opts.send(body);
    return httpRequest(`${this.#opts.gateUrl}/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 10_000,
    });
  }

  /** One tick: send one request unless the in-flight cap is reached. */
  tick(): void {
    if (this.inFlight >= (this.#opts.maxInFlight ?? MAX_IN_FLIGHT)) {
      this.skipped++;
      return;
    }
    this.inFlight++;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    this.sent++;
    let p: Promise<unknown>;
    try {
      p = Promise.resolve(this.#send(syntheticOrder(++this.#seq)));
    } catch {
      p = Promise.reject(new Error('send failed'));
    }
    p.catch(() => {
      this.failed++;
    }).finally(() => {
      this.inFlight--;
    });
  }

  start(): void {
    if (this.#timer || !(this.#opts.rps > 0)) return;
    const schedule = () => {
      this.#timer = setTimeout(() => {
        this.tick();
        schedule();
      }, nextInterval(this.#opts.rps, (this.#opts.rand ?? Math.random)()));
      this.#timer.unref();
    };
    schedule();
  }

  stop(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
