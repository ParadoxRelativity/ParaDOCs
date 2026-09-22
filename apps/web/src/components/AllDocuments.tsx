import { useMemo, useState } from 'react';
import type { DocumentSummary, FolderNode } from '@paradocs/shared';
import {
  useAllDocuments,
  useCreateDocument,
  useTree,
  useUpdateDocument,
  type DocumentSort,
} from '../api/hooks';
import { cx, formatRelative } from '../lib/util';
import { useFolderOptions } from './DocumentMeta';
import { Button, Spinner, TagChip } from './ui';
import { DocumentIcon } from './Icon';
import { useDocumentImport } from './ImportDocument';

const PAGE = 100;

interface Props {
  workspaceId: string;
  onOpen: (documentId: string) => void;
}

/**
 * Flat view of every document in the workspace, filed or not. New documents land
 * here rather than in a folder, and this is where they get organized.
 */
export default function AllDocuments({ workspaceId, onOpen }: Props) {
  const [sort, setSort] = useState<DocumentSort>('updated');
  const [archived, setArchived] = useState(false);
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(PAGE);

  const list = useAllDocuments(workspaceId, { sort, archived, limit });
  const createDocument = useCreateDocument(workspaceId);
  const tree = useTree(workspaceId);
  const documentImport = useDocumentImport(workspaceId, onOpen);

  // Folder id -> display path, so each row can show where a document lives.
  const folderPaths = useMemo(() => {
    const paths = new Map<string, string>();
    const walk = (folders: FolderNode[], prefix: string[]) => {
      for (const folder of folders) {
        const trail = [...prefix, folder.name];
        paths.set(folder.id, trail.join(' / '));
        walk(folder.children, trail);
      }
    };
    walk(tree.data?.folders ?? [], []);
    return paths;
  }, [tree.data]);

  const documents = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = list.data?.documents ?? [];
    if (!needle) return all;
    return all.filter((doc) => doc.title.toLowerCase().includes(needle));
  }, [list.data, filter]);

  async function newDocument() {
    // Unfiled on purpose: it appears here, and gets a folder when the user picks one.
    const doc = await createDocument.mutateAsync({ folderId: null });
    onOpen(doc.id);
  }

  const control =
    'rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]';

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-8 py-8">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">All documents</h1>
            <p className="text-sm text-[var(--color-muted)]">
              {list.data ? `${documents.length} shown` : 'Loading…'}
              {list.data?.hasMore && ' · more available'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="subtle"
              onClick={documentImport.choose}
              disabled={documentImport.importing}
              title="Markdown, HTML or Word (.docx)"
            >
              {documentImport.importing ? 'Importing…' : 'Import'}
            </Button>
            {documentImport.input}
            <Button variant="primary" onClick={newDocument} disabled={createDocument.isPending}>
              + New document
            </Button>
          </div>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            className={cx(control, 'min-w-48 flex-1')}
            placeholder="Filter by title…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <select className={control} value={sort} onChange={(e) => setSort(e.target.value as DocumentSort)}>
            <option value="updated">Last updated</option>
            <option value="created">Recently created</option>
            <option value="title">Title A–Z</option>
          </select>
          <label className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
            Archived
          </label>
        </div>

        {list.isLoading ? (
          <Spinner />
        ) : documents.length === 0 ? (
          <p className="py-16 text-center text-sm text-[var(--color-muted)]">
            {filter ? 'No documents match that filter.' : 'No documents yet. Create one to get started.'}
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-[var(--color-line)]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-line)] bg-[var(--color-surface)] text-left text-[11px] uppercase tracking-wide text-[var(--color-muted)]">
                  <th className="px-3 py-2 font-semibold">Title</th>
                  <th className="w-44 px-3 py-2 font-semibold">Folder</th>
                  <th className="px-3 py-2 font-semibold">Tags</th>
                  <th className="w-28 px-3 py-2 text-right font-semibold">Updated</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => (
                  <DocumentRow
                    key={doc.id}
                    doc={doc}
                    workspaceId={workspaceId}
                    folderPath={doc.folderId ? folderPaths.get(doc.folderId) : undefined}
                    onOpen={onOpen}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {list.data?.hasMore && (
          <div className="mt-3 text-center">
            <Button variant="subtle" className="text-xs" onClick={() => setLimit((n) => n + PAGE)}>
              Load more
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function DocumentRow({
  doc,
  workspaceId,
  folderPath,
  onOpen,
}: {
  doc: DocumentSummary;
  workspaceId: string;
  folderPath: string | undefined;
  onOpen: (id: string) => void;
}) {
  const update = useUpdateDocument(workspaceId, doc.id);
  const folderOptions = useFolderOptions(workspaceId);

  return (
    <tr className="border-b border-[var(--color-line)] last:border-0 hover:bg-[var(--color-surface)]">
      <td className="px-3 py-2">
        <button onClick={() => onOpen(doc.id)} className="flex w-full items-center gap-2 text-left">
          <span className="text-xs">
            <DocumentIcon doc={doc} />
          </span>
          <span className="min-w-0 truncate font-medium hover:text-[var(--color-accent)]">{doc.title}</span>
          {doc.archivedAt && (
            <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600">
              archived
            </span>
          )}
        </button>
      </td>
      <td className="px-3 py-2">
        {/* Filing a document from here is what moves it into the sidebar tree. */}
        <select
          className={cx(
            'w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-xs outline-none',
            'hover:border-[var(--color-line)] focus:border-[var(--color-accent)]',
            !doc.folderId && 'text-[var(--color-muted)]',
          )}
          value={doc.folderId ?? ''}
          onChange={(e) => update.mutate({ folderId: e.target.value || null })}
          title={folderPath ?? 'Unfiled'}
        >
          <option value="">Unfiled</option>
          {folderOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {doc.tags.map((tag) => (
            <TagChip key={tag.id} name={tag.name} color={tag.color} />
          ))}
          {doc.tags.length === 0 && <span className="text-xs text-[var(--color-muted)]">—</span>}
        </div>
      </td>
      <td className="px-3 py-2 text-right text-xs text-[var(--color-muted)]">
        {formatRelative(doc.updatedAt)}
      </td>
    </tr>
  );
}
