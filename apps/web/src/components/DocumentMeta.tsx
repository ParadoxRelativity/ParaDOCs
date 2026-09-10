import { useMemo, useRef, useState } from 'react';
import type { Doc, FolderNode } from '@paradocs/shared';
import { useCreateTag, useTags, useTree, type DocumentPatch } from '../api/hooks';
import { countWords, cx, formatDateTime, formatRelative } from '../lib/util';
import { TagChip } from './ui';
import Icon from './Icon';

const FIELD =
  'rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1 text-sm ' +
  'outline-none focus:border-[var(--color-accent)]';

interface MetaProps {
  doc: Doc;
  workspaceId: string;
  onPatch: (patch: DocumentPatch) => void;
  /** Viewers see the same rows, but cannot change anything. */
  readOnly?: boolean;
}

/** Flattens the folder tree into indented options for a <select>. */
export function useFolderOptions(workspaceId: string) {
  const tree = useTree(workspaceId);
  return useMemo(() => {
    const options: { id: string; label: string }[] = [];
    const walk = (folders: FolderNode[], depth: number) => {
      for (const folder of folders) {
        options.push({ id: folder.id, label: `${'  '.repeat(depth)}${folder.name}` });
        walk(folder.children, depth + 1);
      }
    };
    walk(tree.data?.folders ?? [], 0);
    return options;
  }, [tree.data]);
}

export function FolderPicker({ doc, workspaceId, onPatch, readOnly }: MetaProps) {
  const options = useFolderOptions(workspaceId);
  return (
    <select
      className={cx(FIELD, 'w-full', readOnly && 'pointer-events-none opacity-70')}
      value={doc.folderId ?? ''}
      disabled={readOnly}
      onChange={(e) => onPatch({ folderId: e.target.value || null })}
    >
      <option value="">Unfiled</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function TagEditor({ doc, workspaceId, onPatch, readOnly }: MetaProps) {
  const tags = useTags(workspaceId);
  const createTag = useCreateTag(workspaceId);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const assigned = new Set(doc.tags.map((t) => t.id));
  const available = (tags.data ?? []).filter((t) => !assigned.has(t.id));

  async function commit(name: string) {
    const trimmed = name.trim();
    setDraft('');
    if (!trimmed) return;
    // Typing an unknown name creates the tag, so tagging is never a two-step trip.
    const existing = (tags.data ?? []).find((t) => t.name.toLowerCase() === trimmed.toLowerCase());
    const tag = existing ?? (await createTag.mutateAsync({ name: trimmed }));
    if (assigned.has(tag.id)) return;
    onPatch({ tagIds: [...doc.tags.map((t) => t.id), tag.id] });
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {doc.tags.map((tag) => (
        <TagChip
          key={tag.id}
          name={tag.name}
          color={tag.color}
          onRemove={
            readOnly
              ? undefined
              : () => onPatch({ tagIds: doc.tags.filter((t) => t.id !== tag.id).map((t) => t.id) })
          }
        />
      ))}
      {readOnly && doc.tags.length === 0 && (
        <span className="text-xs text-[var(--color-muted)]">No tags</span>
      )}

      {readOnly ? null : adding ? (
        <input
          ref={inputRef}
          autoFocus
          list="paradocs-tag-options"
          className={cx(FIELD, 'w-40 py-0.5 text-xs')}
          placeholder="Tag name…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void commit(draft);
            }
            if (e.key === 'Escape') {
              setDraft('');
              setAdding(false);
            }
          }}
          onBlur={() => {
            void commit(draft);
            setAdding(false);
          }}
        />
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="rounded-full border border-dashed border-[var(--color-line)] px-2 py-0.5 text-xs text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          + Tag
        </button>
      )}

      <datalist id="paradocs-tag-options">
        {available.map((tag) => (
          <option key={tag.id} value={tag.name} />
        ))}
      </datalist>
    </div>
  );
}

/**
 * Names shown as built-in rows. A custom property using one of these would render
 * as a confusing duplicate, so new ones are rejected. Properties created before
 * this rule still display — they are the user's data to remove.
 */
const RESERVED_PROPERTY_NAMES = new Set([
  'folder',
  'tags',
  'created',
  'updated',
  'owner',
  'words',
  'journal date',
]);

export function PropertyEditor({ doc, onPatch, readOnly }: Omit<MetaProps, 'workspaceId'>) {
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [error, setError] = useState('');
  const entries = Object.entries(doc.properties ?? {});

  function addProperty(key: string) {
    const trimmed = key.trim();
    if (!trimmed) {
      setNewKey('');
      setAdding(false);
      setError('');
      return;
    }
    if (RESERVED_PROPERTY_NAMES.has(trimmed.toLowerCase())) {
      setError(`"${trimmed}" is already shown above.`);
      return;
    }
    if (trimmed in (doc.properties ?? {})) {
      setError(`"${trimmed}" already exists on this document.`);
      return;
    }
    setNewKey('');
    setAdding(false);
    setError('');
    onPatch({ properties: { ...doc.properties, [trimmed]: '' } });
  }

  return (
    <div className="space-y-1">
      {entries.map(([key, value]) => (
        <div key={key} className="group flex items-center gap-2">
          <span className="w-24 shrink-0 truncate text-xs text-[var(--color-muted)]" title={key}>
            {key}
          </span>
          <input
            className={cx(FIELD, 'min-w-0 flex-1 py-0.5 text-xs')}
            defaultValue={value === null ? '' : String(value)}
            readOnly={readOnly}
            placeholder="Empty"
            // Committing on blur avoids a request per keystroke.
            onBlur={(e) => {
              if (e.target.value !== String(value ?? '')) {
                onPatch({ properties: { ...doc.properties, [key]: e.target.value } });
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
          <button
            aria-label={`Remove property ${key}`}
            hidden={readOnly}
            className="shrink-0 px-1 text-xs text-[var(--color-muted)] opacity-0 hover:text-red-500 group-hover:opacity-100"
            onClick={() => {
              const next = { ...doc.properties };
              delete next[key];
              onPatch({ properties: next });
            }}
          >
            <Icon name="x-lg" />
          </button>
        </div>
      ))}

      {readOnly ? null : adding ? (
        <div>
          <input
            autoFocus
            className={cx(FIELD, 'w-full py-0.5 text-xs', error && 'border-red-500')}
            placeholder="Property name, then Enter"
            value={newKey}
            onChange={(e) => {
              setNewKey(e.target.value);
              setError('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addProperty(newKey);
              }
              if (e.key === 'Escape') {
                setNewKey('');
                setAdding(false);
                setError('');
              }
            }}
            // Blur commits, except when the name was rejected: keep it open to fix.
            onBlur={() => {
              if (!error) addProperty(newKey);
            }}
          />
          {error && <p className="mt-0.5 text-[11px] text-red-500">{error}</p>}
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="text-xs text-[var(--color-muted)] hover:text-[var(--color-accent)]"
        >
          + Add property
        </button>
      )}
    </div>
  );
}

/**
 * Properties every document has, derived rather than stored: they are read-only
 * here and rendered the same way in the inline block and the sidebar panel.
 */
export function BuiltInProperties({ doc }: { doc: Doc }) {
  const words = countWords(doc.bodyMd);
  return (
    <>
      <MetaRow label="Created">
        <ReadOnly hint={formatRelative(doc.createdAt)}>{formatDateTime(doc.createdAt)}</ReadOnly>
      </MetaRow>
      <MetaRow label="Updated">
        <ReadOnly hint={formatRelative(doc.updatedAt)}>{formatDateTime(doc.updatedAt)}</ReadOnly>
      </MetaRow>
      <MetaRow label="Owner">
        <ReadOnly hint={doc.owner?.email}>{doc.owner?.name ?? 'Unknown'}</ReadOnly>
      </MetaRow>
      <MetaRow label="Words">
        <ReadOnly>{words.toLocaleString()}</ReadOnly>
      </MetaRow>
      {doc.isJournal && doc.journalDate && (
        <MetaRow label="Journal date">
          <ReadOnly>{doc.journalDate}</ReadOnly>
        </MetaRow>
      )}
    </>
  );
}

function ReadOnly({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <span className="block truncate py-0.5 text-xs text-[var(--color-ink)]" title={hint}>
      {children}
    </span>
  );
}

/**
 * The metadata block shown directly under a document's title, so folder, tags
 * and properties are editable on the document itself rather than only in the
 * right sidebar.
 */
export default function DocumentMeta({ doc, workspaceId, onPatch, readOnly }: MetaProps) {
  const [open, setOpen] = useState(
    () => doc.tags.length > 0 || Object.keys(doc.properties ?? {}).length > 0 || Boolean(readOnly),
  );

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-2 text-xs text-[var(--color-muted)] hover:text-[var(--color-accent)]"
      >
        + Add tags or properties
      </button>
    );
  }

  return (
    <div className="mt-3 space-y-1.5 border-l-2 border-[var(--color-line)] pl-3">
      <MetaRow label="Folder">
        <div className="max-w-xs">
          <FolderPicker doc={doc} workspaceId={workspaceId} onPatch={onPatch} readOnly={readOnly} />
        </div>
      </MetaRow>
      <MetaRow label="Tags">
        <TagEditor doc={doc} workspaceId={workspaceId} onPatch={onPatch} readOnly={readOnly} />
      </MetaRow>

      <BuiltInProperties doc={doc} />

      <div className="pt-1">
        <PropertyEditor doc={doc} onPatch={onPatch} readOnly={readOnly} />
      </div>
    </div>
  );
}

export function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-xs text-[var(--color-muted)]">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
