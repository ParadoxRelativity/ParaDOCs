import { useEffect, useState } from 'react';
import type { SearchHit, SheetSearchHit } from '@paradocs/shared';
import { useSearch, useTags } from '../api/hooks';
import { cx, formatRelative, plainSnippet, useDebounced } from '../lib/util';
import { TagChip } from './ui';
import Icon, { DocumentIcon } from './Icon';

interface Props {
  workspaceId: string;
  onClose: () => void;
  onSelect: (documentId: string) => void;
  /** Spreadsheets are their own app, so opening one goes somewhere else. */
  onSelectSheet: (spreadsheetId: string) => void;
  initialTagIds?: string[];
}

/** One row of results: documents first, then spreadsheets, walked as one list. */
type Result = { kind: 'document'; hit: SearchHit } | { kind: 'sheet'; hit: SheetSearchHit };

export default function SearchPalette({ workspaceId, onClose, onSelect, onSelectSheet, initialTagIds = [] }: Props) {
  const [text, setText] = useState('');
  const [tagIds, setTagIds] = useState<string[]>(initialTagIds);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [cursor, setCursor] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(initialTagIds.length > 0);

  const debounced = useDebounced(text, 180);
  const tags = useTags(workspaceId);
  const hasFilters = tagIds.length > 0 || Boolean(from) || Boolean(to);
  const search = useSearch(
    workspaceId,
    { q: debounced || undefined, tags: tagIds, from: from || undefined, to: to || undefined },
    debounced.length > 0 || hasFilters,
  );

  const hits = search.data?.hits ?? [];
  const sheets = search.data?.sheets ?? [];
  const results: Result[] = [
    ...hits.map((hit): Result => ({ kind: 'document', hit })),
    ...sheets.map((hit): Result => ({ kind: 'sheet', hit })),
  ];
  const open = (result: Result) => (result.kind === 'document' ? onSelect(result.hit.id) : onSelectSheet(result.hit.id));

  useEffect(() => setCursor(0), [debounced, tagIds, from, to]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, results.length - 1));
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
      }
      if (e.key === 'Enter' && results[cursor]) {
        open(results[cursor]);
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const field =
    'rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]" onClick={onClose}>
      <div
        className="w-full max-w-2xl overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-raised)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-line)] px-3">
          <Icon name="search" className="text-sm text-[var(--color-muted)]" />
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search documents and spreadsheets…"
            className="flex-1 bg-transparent py-3 text-sm outline-none"
          />
          <button
            onClick={() => setFiltersOpen((v) => !v)}
            className={cx(
              'rounded px-2 py-1 text-xs',
              hasFilters ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)] hover:text-[var(--color-ink)]',
            )}
          >
            Filters{hasFilters ? ` (${tagIds.length + (from ? 1 : 0) + (to ? 1 : 0)})` : ''}
          </button>
        </div>

        {filtersOpen && (
          <div className="space-y-2 border-b border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-1 text-[11px] text-[var(--color-muted)]">Tags</span>
              {(tags.data ?? []).map((tag) => (
                <TagChip
                  key={tag.id}
                  name={tag.name}
                  color={tag.color}
                  active={tagIds.includes(tag.id)}
                  onClick={() =>
                    setTagIds((ids) => (ids.includes(tag.id) ? ids.filter((i) => i !== tag.id) : [...ids, tag.id]))
                  }
                />
              ))}
              {(tags.data ?? []).length === 0 && (
                <span className="text-[11px] text-[var(--color-muted)]">No tags in this workspace yet</span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-muted)]">
              <span>Updated between</span>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={field} />
              <span>and</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={field} />
              {hasFilters && (
                <button
                  onClick={() => {
                    setTagIds([]);
                    setFrom('');
                    setTo('');
                  }}
                  className="ml-auto hover:text-[var(--color-ink)]"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        )}

        <div className="scroll-thin max-h-[45vh] overflow-y-auto">
          {(debounced || hasFilters) && results.length === 0 && !search.isFetching && (
            <p className="p-6 text-center text-xs text-[var(--color-muted)]">No matching documents or spreadsheets.</p>
          )}
          {hits.map((hit, index) => (
            <button
              key={hit.id}
              onMouseEnter={() => setCursor(index)}
              onClick={() => {
                onSelect(hit.id);
                onClose();
              }}
              className={cx(
                'block w-full border-b border-[var(--color-line)] px-3 py-2.5 text-left last:border-0',
                index === cursor && 'bg-[var(--color-surface)]',
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className="text-xs">
                  <DocumentIcon doc={hit} />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{hit.title}</span>
                {hit.tags.map((tag) => (
                  <span key={tag.id} className="h-1.5 w-1.5 rounded-full" style={{ background: tag.color }} />
                ))}
                <span className="shrink-0 text-[10px] text-[var(--color-muted)]">
                  {formatRelative(hit.updatedAt)}
                </span>
              </div>
              {hit.snippet && (
                <p
                  className="mt-0.5 line-clamp-2 text-xs text-[var(--color-muted)]"
                  // ts_headline returns our own <mark> tags around the matched terms.
                  dangerouslySetInnerHTML={{ __html: highlightSafely(hit.snippet) }}
                />
              )}
              {hit.folderPath.length > 0 && (
                <p className="mt-0.5 text-[10px] text-[var(--color-muted)]">{hit.folderPath.join(' / ')}</p>
              )}
            </button>
          ))}
          {sheets.length > 0 && (
            <div className="border-b border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
              Spreadsheets
            </div>
          )}
          {sheets.map((hit, offset) => {
            const index = hits.length + offset;
            return (
              <button
                key={`sheet-${hit.id}`}
                onMouseEnter={() => setCursor(index)}
                onClick={() => {
                  onSelectSheet(hit.id);
                  onClose();
                }}
                className={cx(
                  'block w-full border-b border-[var(--color-line)] px-3 py-2.5 text-left last:border-0',
                  index === cursor && 'bg-[var(--color-surface)]',
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-xs">{hit.icon ?? <Icon name="table" />}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{hit.title}</span>
                  <span className="shrink-0 text-[10px] text-[var(--color-muted)]">{formatRelative(hit.updatedAt)}</span>
                </div>
                {hit.snippet && (
                  <p
                    className="mt-0.5 line-clamp-2 text-xs text-[var(--color-muted)]"
                    dangerouslySetInnerHTML={{ __html: highlightSafely(hit.snippet) }}
                  />
                )}
              </button>
            );
          })}
        </div>

        <div className="flex gap-3 border-t border-[var(--color-line)] px-3 py-1.5 text-[10px] text-[var(--color-muted)]">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}

/**
 * ts_headline wraps matches in <mark>, but the surrounding text is user content.
 * Escape everything, then restore only the <mark> tags we asked Postgres for.
 */
function highlightSafely(snippet: string): string {
  const escaped = plainSnippet(snippet)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/&lt;mark&gt;/g, '<mark>').replace(/&lt;\/mark&gt;/g, '</mark>');
}
