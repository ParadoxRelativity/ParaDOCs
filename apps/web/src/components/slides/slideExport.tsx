import { useSyncExternalStore } from 'react';
import { usePresentation } from '../../api/hooks';
import SlideExportDialog from './SlideExportDialog';
import { registerSlideToolbarAction, type SlideEditorContext } from './slideExtensions';

/**
 * Export (PARA-97), plugged into the editor through the registries in
 * slideExtensions.tsx: an Export button in the toolbar, shown to viewers too
 * since taking a copy changes nothing, and the dialog it opens, drawn by
 * `SlideExportHost`, which the editor mounts once.
 */

let open = false;
const listeners = new Set<() => void>();

function setOpen(next: boolean) {
  open = next;
  listeners.forEach((listener) => listener());
}

function useOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => open,
  );
}

export function SlideExportHost({ ctx }: { ctx: SlideEditorContext }) {
  return useOpen() ? <OpenExport ctx={ctx} /> : null;
}

/** Only mounted while the dialog is open, so the title is not looked up otherwise. */
function OpenExport({ ctx }: { ctx: SlideEditorContext }) {
  const presentation = usePresentation(ctx.presentationId);
  return <SlideExportDialog presentationId={ctx.presentationId} title={presentation.data?.title ?? 'Presentation'} deck={ctx.deck} onClose={() => setOpen(false)} />;
}

registerSlideToolbarAction({
  id: 'export',
  label: 'Export as PowerPoint or PDF',
  icon: 'download',
  order: 905,
  viewers: true,
  run: () => setOpen(true),
});
