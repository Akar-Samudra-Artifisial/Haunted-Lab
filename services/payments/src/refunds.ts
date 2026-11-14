export interface RefundTerms {
  windowDays: number;
  feeCents: number;
}

export const DEFAULT_TERMS: RefundTerms = { windowDays: 14, feeCents: 0 };

// Synthetic refund table. Buckets 0..6 have a record; buckets 7..9 (about 30% of orders) do not.
const REFUND_TABLE = new Map<number, RefundTerms>([
  [0, { windowDays: 30, feeCents: 0 }],
  [1, { windowDays: 30, feeCents: 50 }],
  [2, { windowDays: 14, feeCents: 0 }],
  [3, { windowDays: 14, feeCents: 25 }],
  [4, { windowDays: 7, feeCents: 0 }],
  [5, { windowDays: 7, feeCents: 100 }],
  [6, { windowDays: 60, feeCents: 0 }],
]);

export function refundBucket(orderId: string): number {
  let sum = 0;
  for (let i = 0; i < orderId.length; i++) sum += orderId.charCodeAt(i);
  return sum % 10;
}

export function findRefund(orderId: string): RefundTerms | undefined {
  return REFUND_TABLE.get(refundBucket(orderId));
}

export function refundTerms(orderId: string): RefundTerms {
  const refund = findRefund(orderId);
  if (!refund) {
    return DEFAULT_TERMS;
  }
  return { windowDays: refund.windowDays, feeCents: refund.feeCents };
}
