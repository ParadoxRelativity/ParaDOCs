import { useSyncExternalStore } from 'react';

/**
 * Which cells of a table are selected, shared between the table on the stage
 * and the inspector that formats them. Like the rich text session there is one
 * slot: only one table is worked on at a time.
 */
export interface TableSelection {
  elementId: string;
  anchor: { row: number; column: number };
  focus: { row: number; column: number };
}

let current: TableSelection | null = null;
const listeners = new Set<() => void>();

export function setTableSelection(next: TableSelection | null) {
  current = next;
  for (const listener of listeners) listener();
}

export function clearTableSelection(elementId: string) {
  if (current?.elementId === elementId) setTableSelection(null);
}

export function useTableSelection(): TableSelection | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => current,
    () => null,
  );
}
