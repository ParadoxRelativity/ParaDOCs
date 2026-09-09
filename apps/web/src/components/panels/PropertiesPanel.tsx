import { useState } from 'react';
import type { Doc } from '@paradocs/shared';
import type { DocumentPatch } from '../../api/hooks';
import { api } from '../../api/client';
import { Button } from '../ui';
import { ConfirmDialog } from '../Modal';
import { useToast } from '../Toast';
import { BuiltInProperties, FolderPicker, PropertyEditor, TagEditor } from '../DocumentMeta';

interface Props {
  doc: Doc;
  workspaceId: string;
  onPatch: (patch: DocumentPatch) => void;
  onDelete: () => void;
}

/**
 * The same editors the document itself shows, plus the read-only info and the
 * destructive actions that do not belong inline in the document.
 */
export default function PropertiesPanel({ doc, workspaceId, onPatch, onDelete }: Props) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const toast = useToast();

  async function exportMarkdown() {
    const markdown = await api.text(`/documents/${doc.id}/markdown`);
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${doc.title.replace(/[^\w -]/g, '') || 'document'}.md`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-5 p-3 text-sm">
      <section>
        <Label>Mode</Label>
        <div className="grid grid-cols-2 gap-1.5">
          {(['page', 'canvas'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => doc.mode !== mode && onPatch({ mode })}
              className={
                'rounded-md border px-2 py-1.5 text-xs ' +
                (doc.mode === mode
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                  : 'border-[var(--color-line)] hover:bg-[var(--color-surface)]')
              }
            >
              {mode === 'page' ? '📄 Page' : '🎨 Canvas'}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-[var(--color-muted)]">
          Both modes keep their own content, so switching back and forth loses nothing.
        </p>
      </section>

      <section>
        <Label>Folder</Label>
        <FolderPicker doc={doc} workspaceId={workspaceId} onPatch={onPatch} />
      </section>

      <section>
        <Label>Tags</Label>
        <TagEditor doc={doc} workspaceId={workspaceId} onPatch={onPatch} />
      </section>

      <section>
        <Label>Custom properties</Label>
        <PropertyEditor doc={doc} onPatch={onPatch} />
      </section>

      <section className="space-y-1">
        <Label>Info</Label>
        <BuiltInProperties doc={doc} />
      </section>

      <section className="space-y-1.5 border-t border-[var(--color-line)] pt-3">
        <Button variant="subtle" className="w-full justify-center text-xs" onClick={exportMarkdown}>
          Export as Markdown
        </Button>
        <Button
          variant="subtle"
          className="w-full justify-center text-xs"
          onClick={() => {
            onPatch({ archived: !doc.archivedAt });
            toast(doc.archivedAt ? 'Document restored' : 'Document archived');
          }}
        >
          {doc.archivedAt ? 'Restore from archive' : 'Archive document'}
        </Button>
        <Button
          variant="danger"
          className="w-full justify-center text-xs"
          onClick={() => setConfirmingDelete(true)}
        >
          Delete permanently
        </Button>
      </section>

      {confirmingDelete && (
        <ConfirmDialog
          title={`Delete "${doc.title}"?`}
          description="This permanently removes the document, its comments and its history. It cannot be undone. Archive it instead if you only want it out of the way."
          confirmLabel="Delete permanently"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false);
            toast(`Deleted "${doc.title}"`);
            onDelete();
          }}
        />
      )}
    </div>
  );
}

const Label = ({ children }: { children: React.ReactNode }) => (
  <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
    {children}
  </div>
);
