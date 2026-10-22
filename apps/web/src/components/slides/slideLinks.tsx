import { createContext, useContext, useEffect, type ReactNode, type SyntheticEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { formatDueDate, workItemPath, workItemPercent, type SheetRef } from '@paradocs/shared';
import { useDocument } from '../../api/hooks';
import { renderMarkdownPreview } from '../../lib/markdownPreview';
import { refreshAllKnown, useLiveSheetRef } from '../../lib/sheetRefs';
import { openTab } from '../../lib/tabs';
import { useWorkItemDetail } from '../../lib/workItemRefs';
import { cx } from '../../lib/util';
import Icon from '../Icon';
import { ChartPlot } from '../sheet/SheetChartView';
import { StatusPill } from '../projects/projectUi';

/**
 * Following live content from a slide while it is presented: a document, work
 * item or spreadsheet shown on a slide (or named by a field in its text)
 * opens over the show when clicked, read as it is now, with a way to open it
 * in a tab of its own behind the show. The slide stays where it was, so the
 * presenter carries on from it.
 *
 * Only the show provides somewhere to open things. On the stage a click
 * selects, and in thumbnails it opens the slide, so there nothing is a link.
 */

export type SlideLinkTarget =
  | { kind: 'document'; documentId: string }
  | { kind: 'workItem'; itemId: string }
  | { kind: 'sheet'; ref: SheetRef };

export const SlideLinkContext = createContext<((target: SlideLinkTarget) => void) | null>(null);

/** How to open a target, where the slide is being presented; null anywhere else. */
export function useSlideLink(): ((target: SlideLinkTarget) => void) | null {
  return useContext(SlideLinkContext);
}

/** The workspace the page is in. References never leave their workspace, so this is theirs too. */
export function pathWorkspaceId(): string | null {
  return /^\/w\/([^/]+)/.exec(window.location.pathname)?.[1] ?? null;
}

/** Keeps a press on a link from also reaching the show, which would take it as "next slide". */
export const stopShow = (e: SyntheticEvent) => e.stopPropagation();

/**
 * Makes what it wraps open `target` when clicked in a show, and leaves it
 * alone everywhere else. The slide is drawn ignoring the pointer, so the area
 * claims it back for itself.
 */
export function SlideLinkArea({ target, label, children }: { target: SlideLinkTarget | null; label: string; children: ReactNode }) {
  const open = useSlideLink();
  if (!open || !target) return <>{children}</>;
  return (
    <div
      role="link"
      aria-label={label}
      title={label}
      className="h-full w-full cursor-pointer"
      style={{ pointerEvents: 'auto' }}
      onPointerDown={stopShow}
      onPointerUp={stopShow}
      onClick={(e) => {
        e.stopPropagation();
        open(target);
      }}
    >
      {children}
    </div>
  );
}

/**
 * Starting a show asks again for everything live a deck can show, so the
 * first look at each slide has the latest numbers rather than those the editor
 * last fetched.
 */
export function useRefreshLiveContent() {
  const queryClient = useQueryClient();
  useEffect(() => {
    refreshAllKnown();
    for (const key of ['workItemRef', 'workItemDetail', 'document']) void queryClient.invalidateQueries({ queryKey: [key] });
  }, [queryClient]);
}

// ---------------------------------------------------------------------------
// The peek
// ---------------------------------------------------------------------------

/**
 * What a target opened in a show looks like: over the slide, readable from the
 * room, closed by its button, a click outside, Esc in a windowed show or
 * Android back. (In full screen the browser keeps Esc for leaving full screen.)
 */
export function SlideLinkPeek({ target, onClose }: { target: SlideLinkTarget; onClose: () => void }) {
  const workspaceId = pathWorkspaceId();
  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-[4vmin]"
      onPointerDown={stopShow}
      onPointerUp={stopShow}
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      onContextMenu={stopShow}
    >
      <div
        role="dialog"
        aria-label="Linked content"
        className="flex max-h-full w-full max-w-4xl cursor-auto select-text flex-col overflow-hidden rounded-2xl bg-white text-zinc-900 shadow-2xl"
      >
        {target.kind === 'document' && <DocumentPeek documentId={target.documentId} workspaceId={workspaceId} onClose={onClose} />}
        {target.kind === 'workItem' && <WorkItemPeek itemId={target.itemId} workspaceId={workspaceId} onClose={onClose} />}
        {target.kind === 'sheet' && <SheetPeek sheetRef={target.ref} workspaceId={workspaceId} onClose={onClose} />}
      </div>
    </div>
  );
}

function PeekFrame({
  icon,
  title,
  subtitle,
  path,
  tabLabel,
  onClose,
  children,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  title: string;
  subtitle?: ReactNode;
  /** Where "Open in a tab" goes; absent while what it is cannot be shown. */
  path: string | null;
  tabLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <div className="flex items-start gap-3 border-b border-zinc-200 px-6 py-4">
        <Icon name={icon} className="mt-1 text-xl text-zinc-500" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xl font-semibold">{title}</p>
          {subtitle && <div className="mt-0.5 text-sm text-zinc-500">{subtitle}</div>}
        </div>
        {path && (
          <button
            className="shrink-0 rounded-md px-2.5 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100"
            title="Opens behind the show, for when it ends"
            onClick={() => {
              openTab(path, tabLabel, { background: true });
              onClose();
            }}
          >
            <Icon name="box-arrow-up-right" className="mr-1.5" />
            Open in a tab
          </button>
        )}
        <button aria-label="Close" title="Close" className="shrink-0 rounded-md px-2 py-1.5 text-zinc-500 hover:bg-zinc-100" onClick={onClose}>
          <Icon name="x-lg" />
        </button>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-5 text-lg leading-relaxed">{children}</div>
    </>
  );
}

function Unavailable({ what, onClose }: { what: string; onClose: () => void }) {
  return (
    <PeekFrame icon="lock-fill" title={`${what} is not available`} path={null} tabLabel="" onClose={onClose}>
      <p className="text-zinc-500">You may not have access to its source.</p>
    </PeekFrame>
  );
}

const Loading = () => <p className="px-6 py-10 text-center text-zinc-500">Loading…</p>;

function DocumentPeek({ documentId, workspaceId, onClose }: { documentId: string; workspaceId: string | null; onClose: () => void }) {
  const doc = useDocument(documentId);
  if (doc.isLoading) return <Loading />;
  if (!doc.data) return <Unavailable what="This document" onClose={onClose} />;
  const text = doc.data.bodyMd?.trim() ?? '';
  return (
    <PeekFrame
      icon={doc.data.mode === 'canvas' ? 'easel' : 'file-earmark-text'}
      title={doc.data.title || 'Untitled'}
      path={workspaceId ? `/w/${workspaceId}/d/${documentId}` : null}
      tabLabel={doc.data.title || 'Untitled'}
      onClose={onClose}
    >
      {doc.data.mode === 'canvas' ? (
        <p className="text-zinc-500">A canvas — open it in a tab to see it.</p>
      ) : text ? (
        <div className="space-y-3">{renderMarkdownPreview(text)}</div>
      ) : (
        <p className="text-zinc-500">Empty document</p>
      )}
    </PeekFrame>
  );
}

function WorkItemPeek({ itemId, workspaceId, onClose }: { itemId: string; workspaceId: string | null; onClose: () => void }) {
  const query = useWorkItemDetail(itemId, true);
  const item = query.data;
  if (!item) return query.isLoading ? <Loading /> : <Unavailable what="This work item" onClose={onClose} />;
  const percent = workItemPercent(item);
  return (
    <PeekFrame
      icon="kanban"
      title={item.title}
      subtitle={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium">{item.key}</span>
          <StatusPill status={{ name: item.statusName, color: item.statusColor, category: item.statusCategory }} />
          {item.people.length > 0 && <span>{item.people.join(', ')}</span>}
          {item.dueDate && <span>Due {formatDueDate(item.dueDate)}</span>}
        </span>
      }
      path={workspaceId ? workItemPath(workspaceId, item.projectId, item.id) : null}
      tabLabel={`${item.key} ${item.title}`}
      onClose={onClose}
    >
      {item.progress ? (
        <>
          <div className="flex items-baseline justify-between text-base">
            <span className="font-semibold">{percent}% done</span>
            <span className="text-zinc-500">
              {item.progress.done} of {item.progress.total}
            </span>
          </div>
          <div className="mt-2 h-3 overflow-hidden rounded-full bg-zinc-200">
            <div className="h-full rounded-full bg-emerald-500" style={{ width: `${percent}%` }} />
          </div>
          <ul className="mt-5 divide-y divide-zinc-100">
            {item.children.map((child) => (
              <li key={child.id} className="flex items-center gap-3 py-2 text-base">
                <span className="w-24 shrink-0 text-zinc-500">{child.key}</span>
                <span className={cx('min-w-0 flex-1 truncate', child.statusCategory === 'done' && 'text-zinc-500 line-through')}>{child.title}</span>
                <StatusPill status={{ name: child.statusName, color: child.statusColor, category: child.statusCategory }} />
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-zinc-500">Nothing is under this item.</p>
      )}
    </PeekFrame>
  );
}

function SheetPeek({ sheetRef, workspaceId, onClose }: { sheetRef: SheetRef; workspaceId: string | null; onClose: () => void }) {
  const result = useLiveSheetRef(sheetRef, true);
  if (!result) return <Loading />;
  if (result.status !== 'ok') return <Unavailable what={sheetRef.kind === 'cell' ? 'This value' : 'This chart'} onClose={onClose} />;
  const path = workspaceId ? `/w/${workspaceId}/s/${sheetRef.spreadsheetId}` : null;
  return (
    <PeekFrame
      icon={result.kind === 'chart' ? 'bar-chart' : 'table'}
      title={result.kind === 'chart' ? result.title || 'Chart' : result.cell}
      subtitle={`${result.spreadsheetTitle} › ${result.sheetName}`}
      path={path}
      tabLabel={result.spreadsheetTitle}
      onClose={onClose}
    >
      {result.kind === 'chart' ? (
        <div className="h-[55vh]">
          <ChartPlot kind={result.chartKind} data={result.data} />
        </div>
      ) : (
        <p className={cx('py-6 text-center text-7xl font-semibold tabular-nums', result.isError && 'text-red-600')}>{result.display}</p>
      )}
    </PeekFrame>
  );
}
