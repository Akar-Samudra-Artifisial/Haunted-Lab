import { asObject, createLabServer, createMetrics, readId, readInt, type LabServer } from '@haunted-lab/common';

const MAX_ENTRIES = 1000;

export interface LedgerEntry {
  entryId: string;
  orderId: string;
  paymentId: string;
  amountCents: number;
}

export function createLedger(options: { sink?: (line: string) => void } = {}): LabServer {
  const entries: LedgerEntry[] = [];
  let seq = 0;
  return createLabServer({
    name: 'ledger',
    metrics: createMetrics(),
    sink: options.sink,
    routes: [
      {
        method: 'POST',
        path: '/ledger/entries',
        handler: async (ctx) => {
          const body = asObject(await ctx.readJson());
          const entry: LedgerEntry = {
            entryId: `le-${++seq}`,
            orderId: readId(body, 'orderId'),
            paymentId: readId(body, 'paymentId'),
            amountCents: readInt(body, 'amountCents', 1, 1_000_000),
          };
          entries.push(entry);
          if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
          return { status: 201, body: { entryId: entry.entryId } };
        },
      },
    ],
  });
}
