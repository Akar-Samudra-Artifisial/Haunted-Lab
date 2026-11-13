import { callJson, createLabServer, createMetrics, readOrder, type LabServer } from '@haunted-lab/common';
import { reserveStock } from './inventory.ts';

export function createOrders(options: { paymentsUrl: string; sink?: (line: string) => void }): LabServer {
  return createLabServer({
    name: 'orders',
    metrics: createMetrics(),
    sink: options.sink,
    routes: [
      {
        method: 'POST',
        path: '/orders',
        handler: async (ctx) => {
          const order = readOrder(await ctx.readJson());
          await reserveStock(order.sku);
          const payment = (await callJson(
            `${options.paymentsUrl}/payments/charge`,
            { orderId: order.orderId, amountCents: order.amountCents },
            { requestId: ctx.requestId },
          )) as { paymentId?: string; ledgerEntryId?: string };
          return {
            status: 200,
            body: {
              orderId: order.orderId,
              paymentId: payment.paymentId ?? '',
              ledgerEntryId: payment.ledgerEntryId ?? '',
              reserved: true,
            },
          };
        },
      },
    ],
  });
}
