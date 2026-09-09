import { useState } from 'react';
import { useAttachUpload, useDeleteUpload, useUploads, type WorkspaceUpload } from '../api/hooks';
import { useFolderOptions } from './DocumentMeta';
import { cx, formatRelative } from '../lib/util';
import { ConfirmDialog, Modal } from './Modal';
import { useToast } from './Toast';
import { Button, Spinner } from './ui';

interface Props {
  workspaceId: string;
  onOpenDocument: (documentId: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function iconFor(mimeType: string) {
  if (mimeType.startsWith('image/')) return '🖼';
  if (mimeType.startsWith('video/')) return '🎬';
  if (mimeType.startsWith('audio/')) return '🎵';
  return '📎';
}

/**
 * Storage housekeeping for owners and admins.
 *
 * A file is "unattached" when no document owns it: either it was uploaded
 * without one, or the document holding it was deleted, which nulls the
 * reference rather than removing the file.
 */
export default function UploadsPanel({ workspaceId, onOpenDocument }: Props) {
  const [unattachedOnly, setUnattachedOnly] = useState(true);
  const [attaching, setAttaching] = useState<WorkspaceUpload | null>(null);
  const [deleting, setDeleting] = useState<WorkspaceUpload | null>(null);

  const uploads = useUploads(workspaceId, unattachedOnly, true);
  const deleteUpload = useDeleteUpload(workspaceId);
  const toast = useToast();

  const totals = uploads.data?.totals;
  const rows = uploads.data?.uploads ?? [];

  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--color-muted)]">
        Files uploaded to this workspace. A file is unattached when no document owns it — it was
        uploaded on its own, or the document holding it was deleted. Deleting a file here removes it
        from disk permanently.
      </p>

      {totals && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md bg-[var(--color-surface)] px-3 py-2 text-xs">
          <span>
            <strong>{totals.unattached}</strong> unattached
            <span className="text-[var(--color-muted)]"> ({formatBytes(totals.unattached_bytes)})</span>
          </span>
          <span className="text-[var(--color-muted)]">
            {totals.total} total · {formatBytes(totals.bytes)}
          </span>
          <label className="ml-auto flex items-center gap-1.5 text-[var(--color-muted)]">
            <input
              type="checkbox"
              checked={!unattachedOnly}
              onChange={(e) => setUnattachedOnly(!e.target.checked)}
            />
            Show attached too
          </label>
        </div>
      )}

      {uploads.isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-xs text-[var(--color-muted)]">
          {unattachedOnly ? 'No unattached files. Nothing to clean up.' : 'No uploads yet.'}
        </p>
      ) : (
        <ul className="space-y-1">
          {rows.map((upload) => (
            <li
              key={upload.id}
              className="flex items-center gap-2 rounded-md border border-[var(--color-line)] p-2"
            >
              {upload.mimeType.startsWith('image/') ? (
                <img
                  src={upload.url}
                  alt=""
                  className="h-9 w-9 shrink-0 rounded object-cover"
                  // A row for a file whose bytes are gone should still be removable.
                  onError={(e) => (e.currentTarget.style.visibility = 'hidden')}
                />
              ) : (
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded bg-[var(--color-surface)]">
                  {iconFor(upload.mimeType)}
                </span>
              )}

              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{upload.filename}</p>
                <p className="truncate text-[11px] text-[var(--color-muted)]">
                  {formatBytes(upload.byteSize)} · {formatRelative(upload.createdAt)}
                  {upload.documentTitle && (
                    <>
                      {' · in '}
                      <button
                        onClick={() => upload.documentId && onOpenDocument(upload.documentId)}
                        className="underline hover:text-[var(--color-accent)]"
                      >
                        {upload.documentTitle}
                      </button>
                    </>
                  )}
                </p>
              </div>

              <a
                href={upload.url}
                target="_blank"
                rel="noreferrer"
                title="Open the file"
                className="shrink-0 px-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]"
              >
                ⇱
              </a>
              {!upload.documentId && (
                <Button variant="subtle" className="shrink-0 text-[11px]" onClick={() => setAttaching(upload)}>
                  Attach…
                </Button>
              )}
              <button
                onClick={() => setDeleting(upload)}
                aria-label={`Delete ${upload.filename}`}
                className="shrink-0 px-1 text-xs text-[var(--color-muted)] hover:text-red-500"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {attaching && (
        <AttachDialog
          upload={attaching}
          workspaceId={workspaceId}
          onClose={() => setAttaching(null)}
          onDone={(documentId, title) => {
            setAttaching(null);
            toast(`Created "${title}"`);
            onOpenDocument(documentId);
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.filename}?`}
          description="This removes the file from disk permanently. Anything still pointing at it will show a broken link."
          confirmLabel="Delete file"
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const target = deleting;
            setDeleting(null);
            deleteUpload.mutate(target.id, {
              onSuccess: () => toast(`Deleted ${target.filename}`),
              onError: (err) =>
                toast(err instanceof Error ? err.message : 'Could not delete file', 'error'),
            });
          }}
        />
      )}
    </div>
  );
}

/** Creates a document holding the file, which also re-homes the attachment. */
function AttachDialog({
  upload,
  workspaceId,
  onClose,
  onDone,
}: {
  upload: WorkspaceUpload;
  workspaceId: string;
  onClose: () => void;
  onDone: (documentId: string, title: string) => void;
}) {
  const attach = useAttachUpload(workspaceId);
  const folders = useFolderOptions(workspaceId);
  const toast = useToast();
  const [title, setTitle] = useState(upload.filename);
  const [folderId, setFolderId] = useState('');

  const field =
    'w-full rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]';

  function submit() {
    attach.mutate(
      { uploadId: upload.id, title: title.trim() || upload.filename, folderId: folderId || null },
      {
        onSuccess: (result) => onDone(result.document.id, result.document.title),
        onError: (err) =>
          toast(err instanceof Error ? err.message : 'Could not attach the file', 'error'),
      },
    );
  }

  return (
    <Modal
      title="Attach to a new document"
      description={`A new document will be created containing ${upload.filename}, which takes the file out of the unattached list.`}
      onClose={onClose}
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" className="text-xs" onClick={submit} disabled={attach.isPending}>
            {attach.isPending ? 'Creating…' : 'Create document'}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--color-muted)]">Document title</span>
          <input
            autoFocus
            className={field}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--color-muted)]">Folder</span>
          <select className={cx(field)} value={folderId} onChange={(e) => setFolderId(e.target.value)}>
            <option value="">Unfiled</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Modal>
  );
}
