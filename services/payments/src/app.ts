import { callJson, asObject, createLabServer, createMetrics, readId, readInt, type LabServer } from '@haunted-lab/common';
import { refundTerms } from './refunds.ts';

export function createPayments(options: { ledgerUrl: string; sink?: (line: string) => void }): LabServer {
  let seq = 0;
  return createLabServer({
    name: 'payments',
    metrics: createMetrics(),
    sink: options.sink,
    routes: [
      {
        method: 'POST',
        path: '/payments/charge',
        handler: async (ctx) => {
          const body = asObject(await ctx.readJson());
          const orderId = readId(body, 'orderId');
          const amountCents = readInt(body, 'amountCents', 1, 1_000_000);
          const terms = refundTerms(orderId);
          const paymentId = `pay-${++seq}`;
          const entry = (await callJson(
            `${options.ledgerUrl}/ledger/entries`,
            { orderId, paymentId, amountCents },
            { requestId: ctx.requestId },
          )) as { entryId?: string };
          return {
            status: 200,
            body: {
              paymentId,
              ledgerEntryId: entry.entryId ?? '',
              status: 'captured',
              refundWindowDays: terms.windowDays,
            },
          };
        },
      },
    ],
  });
}
