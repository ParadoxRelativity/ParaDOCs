import { useSyncExternalStore } from 'react';
import type { EditorView } from 'prosemirror-view';
import { formatState, type FormatState } from './richTextCommands';

/**
 * The one rich text editor open on the stage, which the inspector's formatting
 * controls act on. Only the slide on stage mounts editors and only one box is
 * edited at a time, so a single slot is enough. A new snapshot is published on
 * every change of selection or content, which is what the controls re-read.
 */
export interface ActiveEditor {
  elementId: string;
  view: EditorView;
  format: FormatState;
}

let active: ActiveEditor | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function publishEditor(elementId: string, view: EditorView) {
  active = { elementId, view, format: formatState(view.state) };
  emit();
}

export function clearEditor(elementId: string) {
  if (active?.elementId !== elementId) return;
  active = null;
  emit();
}

export function useActiveEditor(): ActiveEditor | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => active,
    () => null,
  );
}
