export const SERVICES = ['gate', 'orders', 'payments', 'ledger'] as const;
export type ServiceName = (typeof SERVICES)[number];

export const isServiceName = (v: unknown): v is ServiceName => typeof v === 'string' && (SERVICES as readonly string[]).includes(v);

export type Actor = 'supervisor' | 'chaos' | 'exorcist';

export interface DeployRecord {
  id: string;
  service: ServiceName;
  ref: string;
  sha: string;
  time: string;
  actor: Actor;
}

export type RunStatus = 'starting' | 'running' | 'backoff' | 'stopped';

export interface ServiceState {
  service: ServiceName;
  ref: string;
  sha: string;
  status: RunStatus;
  restarts: number;
  since: string;
  lastExit?: { code: number | null; signal: string | null; time: string };
}

export interface ErrorItem {
  time: string;
  service: ServiceName;
  message: string;
  frame: string;
  requestId: string;
  source: 'service' | 'supervisor';
}

export interface LogItem {
  time: string;
  service: ServiceName;
  stream: 'stdout' | 'stderr';
  line: string;
}
