import type { ServiceName } from './types.ts';

export type ScenarioName = 'error-spike' | 'fog' | 'dark-room';

export interface Scenario {
  name: ScenarioName;
  service: ServiceName;
  ref: string;
  title: string;
}

export const SCENARIOS: Readonly<Record<ScenarioName, Scenario>> = Object.freeze({
  'error-spike': { name: 'error-spike', service: 'payments', ref: 'scenario/error-spike', title: 'simplify refund lookup' },
  fog: { name: 'fog', service: 'orders', ref: 'scenario/fog', title: 'add inventory freshness check' },
  'dark-room': { name: 'dark-room', service: 'ledger', ref: 'scenario/dark-room', title: 'tidy config loading' },
});

export function findScenario(name: string): Scenario | undefined {
  return Object.hasOwn(SCENARIOS, name) ? SCENARIOS[name as ScenarioName] : undefined;
}
