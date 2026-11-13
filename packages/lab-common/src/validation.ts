import { badRequest } from './errors.ts';

const ID = /^[A-Za-z0-9_-]{1,32}$/;

export function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badRequest('body must be a JSON object');
  return value as Record<string, unknown>;
}

/** Short identifier field (letters, digits, `_`, `-`, 1..32 chars). */
export function readId(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || !ID.test(v)) throw badRequest(`${key} must be an id of 1 to 32 characters`);
  return v;
}

export function readInt(obj: Record<string, unknown>, key: string, min: number, max: number): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw badRequest(`${key} must be an integer between ${min} and ${max}`);
  }
  return v;
}

export interface OrderInput {
  orderId: string;
  sku: string;
  qty: number;
  amountCents: number;
}

/** The checkout/order body shared by gate and orders. */
export function readOrder(value: unknown): OrderInput {
  const o = asObject(value);
  return {
    orderId: readId(o, 'orderId'),
    sku: readId(o, 'sku'),
    qty: readInt(o, 'qty', 1, 9),
    amountCents: readInt(o, 'amountCents', 1, 1_000_000),
  };
}
