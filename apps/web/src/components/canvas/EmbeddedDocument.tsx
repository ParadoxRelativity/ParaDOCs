import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BlockNoteView } from '@blocknote/mantine';
import { useCreateBlockNote } from '@blocknote/react';
import { keys, useDocument } from '../../api/hooks';
import { useCollaboration } from '../../lib/collaboration';
import { renderMarkdownPreview } from '../../lib/markdownPreview';
import { cx } from '../../lib/util';

interface Props {
  documentId: string;
  /** Cached at insert time, so the card has a name before the fetch lands. */
  fallbackTitle?: string;
  editing: boolean;
  dark: boolean;
  onOpenFullPage: () => void;
}

/**
 * A document rendered inside a canvas card.
 *
 * At rest it shows a cheap read-only preview of the document's markdown. Double
 * -clicking mounts a real collaborative editor bound to that document's own
 * Y.Doc, so edits made on the board are the same edits as on the page — one
 * websocket per card being edited rather than one per card on the board.
 */
export default function EmbeddedDocument({
  documentId,
  fallbackTitle,
  editing,
  dark,
  onOpenFullPage,
}: Props) {
  const doc = useDocument(documentId);
  const queryClient = useQueryClient();
  const title = doc.data?.title ?? fallbackTitle ?? 'Document';

  // The preview reads body_md, which the collaboration server rewrites a couple
  // of seconds after an edit. Refresh it when inline editing ends.
  useEffect(() => {
    if (editing) return;
    const timer = setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: keys.document(documentId) });
    }, 2500);
    return () => clearTimeout(timer);
  }, [editing, documentId, queryClient]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)]">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-line)] px-2.5 py-1.5">
        <span className="text-[11px]">{doc.data?.mode === 'canvas' ? '🎨' : '📄'}</span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{title}</span>
        <button
          // Pointer events are enabled on this button even when the card body is
          // inert, so opening full page always works.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onOpenFullPage}
          title="Open as a full page"
          className="pointer-events-auto rounded px-1 text-[11px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
        >
          ⇱
        </button>
      </div>

      <div className={cx('min-h-0 flex-1', editing ? 'overflow-auto' : 'overflow-hidden')}>
        {editing ? (
          <LiveDocument documentId={documentId} dark={dark} />
        ) : doc.isLoading ? (
          <p className="p-2.5 text-[11px] text-[var(--color-muted)]">Loading…</p>
        ) : doc.data?.mode === 'canvas' ? (
          <p className="p-2.5 text-[11px] text-[var(--color-muted)]">
            Canvas document — open it as a full page to edit.
          </p>
        ) : doc.data?.bodyMd?.trim() ? (
          <div className="p-2.5 text-[11px] leading-snug">
            {renderMarkdownPreview(doc.data.bodyMd)}
          </div>
        ) : (
          <p className="p-2.5 text-[11px] text-[var(--color-muted)]">
            Empty document — double-click to write here.
          </p>
        )}
      </div>
    </div>
  );
}

/** Live editor for the embedded document, mounted only while editing. */
function LiveDocument({ documentId, dark }: { documentId: string; dark: boolean }) {
  // Awareness needs a name; the card shows no cursors, so a neutral one is fine.
  const { session, user } = useCollaboration(documentId, { id: documentId, name: 'You' });

  if (!session) {
    return <p className="p-2.5 text-[11px] text-[var(--color-muted)]">Connecting…</p>;
  }
  return <LiveSurface session={session} user={user} dark={dark} />;
}

function LiveSurface({
  session,
  user,
  dark,
}: {
  session: NonNullable<ReturnType<typeof useCollaboration>['session']>;
  user: { name: string; color: string };
  dark: boolean;
}) {
  const editor = useCreateBlockNote(
    { collaboration: { provider: session.provider, fragment: session.fragment, user } },
    [session],
  );
  return (
    <div className="paradocs-embedded-doc text-[11px]">
      <BlockNoteView editor={editor} theme={dark ? 'dark' : 'light'} />
    </div>
  );
}
