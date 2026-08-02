import { AsyncLocalStorage } from 'node:async_hooks';

import type { AutomationControlState } from './types';

interface AutomationCycleReadModel {
  control?: AutomationControlState;
}

const cycleStorage = new AsyncLocalStorage<AutomationCycleReadModel>();

export async function withAutomationCycleReadModel<T>(work: () => Promise<T>): Promise<T> {
  return cycleStorage.run({}, work);
}

export function getCycleControl(): AutomationControlState | undefined {
  const value = cycleStorage.getStore()?.control;
  return value ? structuredClone(value) : undefined;
}

export function setCycleControl(value: AutomationControlState): void {
  const store = cycleStorage.getStore();
  if (store) store.control = structuredClone(value);
}
