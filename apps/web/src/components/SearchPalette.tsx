import { useEffect, useState } from 'react';
import { useSearch, useTags } from '../api/hooks';
import { cx, formatRelative, plainSnippet, useDebounced } from '../lib/util';
import { TagChip } from './ui';

interface Props {
  workspaceId: string;
  onClose: () => void;
  onSelect: (documentId: string) => void;
  initialTagIds?: string[];
}

export default function SearchPalette({ workspaceId, onClose, onSelect, initialTagIds = [] }: Props) {
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

  useEffect(() => setCursor(0), [debounced, tagIds, from, to]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, hits.length - 1));
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
      }
      if (e.key === 'Enter' && hits[cursor]) {
        onSelect(hits[cursor].id);
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hits, cursor, onClose, onSelect]);

  const field =
    'rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]" onClick={onClose}>
      <div
        className="w-full max-w-2xl overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-raised)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-line)] px-3">
          <span className="text-sm text-[var(--color-muted)]">🔍</span>
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search titles and contents…"
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
          {!debounced && !hasFilters && (
            <p className="p-6 text-center text-xs text-[var(--color-muted)]">
              Search by words in the title or body, then narrow by tag or date.
            </p>
          )}
          {(debounced || hasFilters) && hits.length === 0 && !search.isFetching && (
            <p className="p-6 text-center text-xs text-[var(--color-muted)]">No matching documents.</p>
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
                  {hit.icon ?? (hit.isJournal ? '📔' : hit.mode === 'canvas' ? '🎨' : '📄')}
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
