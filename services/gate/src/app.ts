import { callJson, createLabServer, createMetrics, readOrder, type LabServer } from '@haunted-lab/common';

export function createGate(options: { ordersUrl: string; sink?: (line: string) => void }): LabServer {
  return createLabServer({
    name: 'gate',
    metrics: createMetrics(),
    sink: options.sink,
    routes: [
      {
        method: 'POST',
        path: '/checkout',
        handler: async (ctx) => {
          const order = readOrder(await ctx.readJson());
          const placed = (await callJson(`${options.ordersUrl}/orders`, order, { requestId: ctx.requestId })) as {
            paymentId?: string;
            ledgerEntryId?: string;
          };
          return {
            status: 200,
            body: {
              orderId: order.orderId,
              paymentId: placed.paymentId ?? '',
              ledgerEntryId: placed.ledgerEntryId ?? '',
              status: 'confirmed',
            },
          };
        },
      },
    ],
  });
}
