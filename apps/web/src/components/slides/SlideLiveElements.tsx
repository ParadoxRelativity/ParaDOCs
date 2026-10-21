import { memo, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CanvasElement, SlideSize, WorkspaceMember } from '@paradocs/shared';
import {
  boardBounds,
  canvasElementsToSlide,
  workItemPercent,
  type LinkElement,
  type PersonElement,
  type SheetCellElement,
  type SheetChartElement,
  type SlideElement,
  type WorkItemElement,
  type WorkItemProgressElement,
} from '@paradocs/shared';
import { keys, useDocument, useLinkTargets, useMembers } from '../../api/hooks';
import { LIVE_REFRESH_MS, useLiveSheetRef } from '../../lib/sheetRefs';
import { renderMarkdownPreview } from '../../lib/markdownPreview';
import { useWorkItemDetail, useWorkItemRef } from '../../lib/workItemRefs';
import { cx, useDebounced } from '../../lib/util';
import type { SlidesActions } from '../../lib/slidesStore';
import Icon, { type IconName } from '../Icon';
import { Modal } from '../Modal';
import { Button } from '../ui';
import SheetRefPicker from '../sheet/SheetRefPicker';
import { ChartPlot } from '../sheet/SheetChartView';
import { WorkItemPicker } from '../projects/WorkItemRefs';
import Avatar from '../Avatar';
import { SlideLinkArea, pathWorkspaceId } from './slideLinks';
import { useWatched } from './SlideMediaElements';
import {
  registerSlideElementRenderer,
  registerSlideInsertTool,
  type SlideEditorContext,
  type SlideElementRendererProps,
} from './slideExtensions';

/**
 * Live ParaDOCs content on a slide: a spreadsheet chart or cell, a work item,
 * how far a work item (an epic, usually) has got, a member, and a document
 * excerpt. The slide stores only where the content lives; each
 * viewer's own client asks for the current value, so
 *
 *  - what is shown follows the sheet, item or document while the slide is on
 *    the stage or in the slideshow (thumbnails show the last known value), and
 *  - someone who may not see the source gets a locked placeholder in its place,
 *    never its data, nor even the label the author gave it. The server answers
 *    each lookup for the person asking, so the audience of a live show, who
 *    each draw the slide themselves, see what their own access allows.
 *  - in the slideshow, clicking one opens what it shows over the slide
 *    (slideLinks.tsx), so a presentation can be followed into its sources.
 *
 * Sized for a 1920x1080 slide: type is large enough to read from the back.
 */

/** A slide is a page: it keeps its light colors whatever theme the app is in. */
const LIGHT: CSSProperties = {
  ['--color-canvas' as string]: '#ffffff',
  ['--color-surface' as string]: '#f7f7f8',
  ['--color-raised' as string]: '#ffffff',
  ['--color-line' as string]: '#e4e4e7',
  ['--color-ink' as string]: '#18181b',
  ['--color-muted' as string]: '#71717a',
  ['--color-accent' as string]: '#6366f1',
  ['--color-accent-soft' as string]: '#eef2ff',
  ['--color-series-1' as string]: '#2a78d6',
  ['--color-series-2' as string]: '#eb6834',
};

const CARD = 'flex h-full w-full flex-col overflow-hidden rounded-3xl border-2 border-[var(--color-line)] bg-[var(--color-raised)] text-[var(--color-ink)]';

function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx(CARD, className)} style={LIGHT}>
      {children}
    </div>
  );
}

/** What stands in for content the viewer cannot see. It names only the kind of thing, never the thing. */
function Locked({ icon, what }: { icon: IconName; what: string }) {
  return (
    <Card className="items-center justify-center gap-4 border-dashed bg-[var(--color-surface)] px-10 text-center">
      <span className="relative text-[96px] leading-none text-[var(--color-muted)]">
        <Icon name={icon} />
        <Icon name="lock-fill" className="absolute -bottom-2 -right-6 text-[48px]" />
      </span>
      <span className="text-[40px] font-medium leading-tight">{what} is not available</span>
      <span className="text-[28px] leading-tight text-[var(--color-muted)]">You may not have access to its source.</span>
    </Card>
  );
}

function Loading() {
  return (
    <Card className="items-center justify-center">
      <span className="text-[36px] text-[var(--color-muted)]">Loading…</span>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Sheet cell
// ---------------------------------------------------------------------------

const SheetCellRenderer = memo(function SheetCellRenderer({ element }: SlideElementRendererProps) {
  const el = element as SheetCellElement;
  const [ref, watched] = useWatched<HTMLDivElement>();
  const result = useLiveSheetRef({ kind: 'cell', spreadsheetId: el.spreadsheetId, sheetId: el.sheetId, cell: el.cell }, watched);
  let body: ReactNode;
  if (!result) body = <Loading />;
  else if (result.status !== 'ok' || result.kind !== 'cell') body = <Locked icon="table" what="This value" />;
  else {
    // The value fills the box: as big as the height allows, narrowed until its width fits.
    const byHeight = el.height * 0.5;
    const byWidth = ((el.width - 80) / Math.max(result.display.length, 1)) * 1.7;
    body = (
      <SlideLinkArea target={{ kind: 'sheet', ref: { kind: 'cell', spreadsheetId: el.spreadsheetId, sheetId: el.sheetId, cell: el.cell } }} label={`Open ${result.spreadsheetTitle}`}>
        <Card className="justify-center px-10">
          <span
            className={cx('truncate font-semibold tabular-nums leading-none', result.isError && 'text-red-600')}
            style={{ fontSize: Math.max(32, Math.min(byHeight, byWidth, 360)) }}
          >
            {result.display}
          </span>
          <span className="mt-3 truncate text-[28px] text-[var(--color-muted)]">
            {el.label || result.cell} · {result.spreadsheetTitle} › {result.sheetName}
          </span>
        </Card>
      </SlideLinkArea>
    );
  }
  return (
    <div ref={ref} className="h-full w-full">
      {body}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Sheet chart
// ---------------------------------------------------------------------------

const SheetChartRenderer = memo(function SheetChartRenderer({ element }: SlideElementRendererProps) {
  const el = element as SheetChartElement;
  const [ref, watched] = useWatched<HTMLDivElement>();
  const result = useLiveSheetRef({ kind: 'chart', spreadsheetId: el.spreadsheetId, sheetId: el.sheetId, chartId: el.chartId }, watched);
  let body: ReactNode;
  if (!result) body = <Loading />;
  else if (result.status !== 'ok' || result.kind !== 'chart') body = <Locked icon="bar-chart" what="This chart" />;
  else {
    body = (
      <SlideLinkArea target={{ kind: 'sheet', ref: { kind: 'chart', spreadsheetId: el.spreadsheetId, sheetId: el.sheetId, chartId: el.chartId } }} label={`Open ${result.spreadsheetTitle}`}>
        <Card>
          <div className="flex items-baseline gap-6 border-b-2 border-[var(--color-line)] px-8 py-4">
            <span className="truncate text-[44px] font-semibold">{result.title || el.label || 'Chart'}</span>
            <span className="ml-auto truncate text-[26px] text-[var(--color-muted)]">
              {result.spreadsheetTitle} › {result.sheetName}
            </span>
          </div>
          <div className="min-h-0 flex-1 p-6">
            {result.data.series.length ? (
              <ChartPlot kind={result.chartKind} data={result.data} />
            ) : (
              <div className="grid h-full place-items-center text-[32px] text-[var(--color-muted)]">No numbers in this chart’s range</div>
            )}
          </div>
        </Card>
      </SlideLinkArea>
    );
  }
  return (
    <div ref={ref} className="h-full w-full">
      {body}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Work item
// ---------------------------------------------------------------------------

const WorkItemRenderer = memo(function WorkItemRenderer({ element }: SlideElementRendererProps) {
  const el = element as WorkItemElement;
  const [ref, watched] = useWatched<HTMLDivElement>();
  const query = useWorkItemRef(el.itemId, watched);
  const item = query.data;
  let body: ReactNode;
  if (!item) body = query.isLoading ? <Loading /> : <Locked icon="kanban" what="This work item" />;
  else {
    body = (
      <SlideLinkArea target={{ kind: 'workItem', itemId: el.itemId }} label={`Open ${item.key}`}>
        <Card className="gap-5 p-10">
          <div className="flex items-center gap-4 text-[36px] text-[var(--color-muted)]">
            <Icon name="kanban" />
            <span className="font-semibold">{item.key}</span>
          </div>
          <p
            className={cx('line-clamp-4 text-[64px] font-semibold leading-tight', item.statusCategory === 'done' && 'text-[var(--color-muted)] line-through')}
          >
            {item.title}
          </p>
          <span
            className="mt-auto inline-flex w-fit items-center rounded-full px-6 py-2 text-[34px] font-medium text-white"
            style={{ background: item.statusColor || '#71717a' }}
          >
            {item.statusName}
          </span>
        </Card>
      </SlideLinkArea>
    );
  }
  return (
    <div ref={ref} className="h-full w-full">
      {body}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Document excerpt
// ---------------------------------------------------------------------------

const EXCERPT_CHARS = 1500;

const DocumentRenderer = memo(function DocumentRenderer({ element }: SlideElementRendererProps) {
  const el = element as LinkElement;
  const [ref, watched] = useWatched<HTMLDivElement>();
  const doc = useDocument(el.documentId);
  const queryClient = useQueryClient();
  // The preview reads the document's saved text, which trails an edit by a couple of seconds.
  useEffect(() => {
    if (!watched) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void queryClient.invalidateQueries({ queryKey: keys.document(el.documentId) });
    }, LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [watched, el.documentId, queryClient]);

  let body: ReactNode;
  if (doc.isLoading) body = <Loading />;
  else if (!doc.data) body = <Locked icon="file-earmark-text" what="This document" />;
  else {
    const text = doc.data.bodyMd?.trim() ?? '';
    body = (
      <SlideLinkArea target={{ kind: 'document', documentId: el.documentId }} label={`Open ${doc.data.title || 'the document'}`}>
        <Card>
          <div className="flex items-center gap-4 border-b-2 border-[var(--color-line)] px-8 py-4 text-[44px]">
            <Icon name={doc.data.mode === 'canvas' ? 'easel' : 'file-earmark-text'} className="text-[var(--color-muted)]" />
            <span className="truncate font-semibold">{doc.data.title || el.title || 'Document'}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden px-8 py-5 text-[34px] leading-snug [&_*]:!text-[inherit] [&_h1]:!text-[44px] [&_h2]:!text-[40px] [&_h3]:!text-[36px] [&_pre]:!text-[28px]">
            {doc.data.mode === 'canvas' ? (
              <p className="text-[var(--color-muted)]">A canvas — open the document to see it.</p>
            ) : text ? (
              renderMarkdownPreview(text.slice(0, EXCERPT_CHARS))
            ) : (
              <p className="text-[var(--color-muted)]">Empty document</p>
            )}
          </div>
        </Card>
      </SlideLinkArea>
    );
  }
  return (
    <div ref={ref} className="h-full w-full">
      {body}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Work item progress
// ---------------------------------------------------------------------------

const ProgressRenderer = memo(function ProgressRenderer({ element }: SlideElementRendererProps) {
  const el = element as WorkItemProgressElement;
  const [ref, watched] = useWatched<HTMLDivElement>();
  const query = useWorkItemDetail(el.itemId, watched);
  const item = query.data;
  let body: ReactNode;
  if (!item) body = query.isLoading ? <Loading /> : <Locked icon="kanban" what="This work item" />;
  else {
    const percent = workItemPercent(item);
    const progress = item.progress;
    // The list takes the right half when the card is wide enough to read both.
    const list = el.showChildren !== false && item.children.length > 0 && el.width >= 1000;
    const rows = Math.max(1, Math.floor((el.height - 120) / 64));
    const shown = item.children.slice(0, rows);
    body = (
      <SlideLinkArea target={{ kind: 'workItem', itemId: el.itemId }} label={`Open ${item.key}`}>
        <Card className="flex-row gap-10 p-10">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-4 text-[32px] text-[var(--color-muted)]">
              <Icon name="kanban" />
              <span className="font-semibold">{item.key}</span>
              <span
                className="ml-auto truncate rounded-full px-5 py-1 text-[26px] font-medium text-white"
                style={{ background: item.statusColor || '#71717a' }}
              >
                {item.statusName}
              </span>
            </div>
            <p className="mt-3 line-clamp-2 text-[56px] font-semibold leading-tight">{item.title}</p>
            <div className="mt-auto">
              <div className="flex items-baseline gap-4">
                <span className="text-[120px] font-semibold leading-none tabular-nums">{percent}%</span>
                <span className="text-[34px] text-[var(--color-muted)]">
                  {progress ? `${progress.done} of ${progress.total} done` : item.statusCategory === 'done' ? 'Done' : 'Not done'}
                </span>
              </div>
              <div className="mt-5 flex h-8 overflow-hidden rounded-full bg-[var(--color-surface)]" aria-hidden>
                {item.statuses.length > 0 && progress
                  ? item.statuses.map((s) => <div key={s.name} style={{ width: `${(s.count / progress.total) * 100}%`, background: s.color }} />)
                  : <div style={{ width: `${percent}%`, background: '#10b981' }} />}
              </div>
              {item.statuses.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-[26px] text-[var(--color-muted)]">
                  {item.statuses.map((s) => (
                    <span key={s.name} className="inline-flex items-center gap-2">
                      <span className="h-5 w-5 rounded-full" style={{ background: s.color }} />
                      {s.name} {s.count}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
          {list && (
            <ul className="min-w-0 flex-1 space-y-2 border-l-2 border-[var(--color-line)] pl-10">
              {shown.map((child) => (
                <li key={child.id} className="flex h-14 items-center gap-4 text-[30px]">
                  <span className="h-5 w-5 shrink-0 rounded-full" style={{ background: child.statusColor }} />
                  <span className="shrink-0 text-[var(--color-muted)]">{child.key}</span>
                  <span className={cx('min-w-0 flex-1 truncate', child.statusCategory === 'done' && 'text-[var(--color-muted)] line-through')}>{child.title}</span>
                </li>
              ))}
              {item.children.length > shown.length && (
                <li className="text-[26px] text-[var(--color-muted)]">and {item.children.length - shown.length} more</li>
              )}
            </ul>
          )}
        </Card>
      </SlideLinkArea>
    );
  }
  return (
    <div ref={ref} className="h-full w-full">
      {body}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Person
// ---------------------------------------------------------------------------

const PersonRenderer = memo(function PersonRenderer({ element, members }: SlideElementRendererProps) {
  const el = element as PersonElement;
  // Thumbnails and the show are drawn without the member list the stage has.
  const fetched = useMembers(members.length ? undefined : (pathWorkspaceId() ?? undefined));
  const list = members.length ? members : (fetched.data ?? []);
  const member = list.find((m) => m.userId === el.userId);
  if (!member) {
    if (fetched.isLoading) return <Loading />;
    return (
      <Card className="items-center justify-center gap-3 px-10 text-center">
        <Icon name="person" className="text-[96px] text-[var(--color-muted)]" />
        <span className="text-[36px] text-[var(--color-muted)]">No longer a member of this workspace</span>
      </Card>
    );
  }
  const size = Math.min(el.height - 80, 280);
  return (
    <Card className="flex-row items-center gap-10 px-10">
      {member.avatarUrl ? (
        <img src={member.avatarUrl} alt="" draggable={false} className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />
      ) : (
        <span
          className="grid shrink-0 place-items-center rounded-full bg-[var(--color-accent-soft)] font-semibold text-[var(--color-accent)]"
          style={{ width: size, height: size, fontSize: size * 0.42 }}
        >
          {initials(member.name)}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[64px] font-semibold leading-tight">{member.name}</p>
        <p className="mt-2 truncate text-[34px] text-[var(--color-muted)]">{member.workspaceRole.name}</p>
        <p className="mt-1 truncate text-[30px] text-[var(--color-muted)]">{member.email}</p>
      </div>
    </Card>
  );
});

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

registerSlideElementRenderer('workItemProgress', ProgressRenderer);
registerSlideElementRenderer('person', PersonRenderer);
registerSlideElementRenderer('sheetCell', SheetCellRenderer);
registerSlideElementRenderer('sheetChart', SheetChartRenderer);
registerSlideElementRenderer('workItem', WorkItemRenderer);
registerSlideElementRenderer('link', DocumentRenderer);

// ---------------------------------------------------------------------------
// Inserting
// ---------------------------------------------------------------------------

type Request = { kind: 'cell' | 'chart' | 'workItem' | 'progress' | 'person' | 'document'; ctx: SlideEditorContext };

let current: Request | null = null;
const listeners = new Set<() => void>();

/** The picker a menu entry asks for. Entries only run a function, so the dialog lives in `SlideInsertDialogs`. */
function ask(kind: Request['kind'], ctx: SlideEditorContext) {
  if (!ctx.slide) return;
  current = { kind, ctx };
  listeners.forEach((listener) => listener());
}

function useRequest(): [Request | null, () => void] {
  const [, rerender] = useState(0);
  useEffect(() => {
    const listener = () => rerender((n) => n + 1);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, []);
  return [
    current,
    () => {
      current = null;
      listeners.forEach((listener) => listener());
    },
  ];
}

function place(ctx: SlideEditorContext, width: number, height: number, props: Record<string, unknown> & { type: SlideElement['type'] }) {
  const n = ctx.slide?.elements.length ?? 0;
  const nudge = (n % 6) * 24;
  const id = ctx.actions.createElement(ctx.slide!.id, {
    ...props,
    width,
    height,
    x: Math.round(ctx.center.x - width / 2 + nudge),
    y: Math.round(ctx.center.y - height / 2 + nudge),
  });
  ctx.select([id]);
}

/** The pickers behind the Insert menu's live content entries; mounted once by the editor. */
export function SlideInsertDialogs() {
  const [request, close] = useRequest();
  if (!request) return null;
  const { kind, ctx } = request;
  const confirmLabel = 'Add to slide';
  if (kind === 'cell' || kind === 'chart') {
    return (
      <SheetRefPicker
        kind={kind}
        workspaceId={ctx.workspaceId}
        confirmLabel={confirmLabel}
        onCancel={close}
        onInsert={(ref) => {
          close();
          if (ref.kind === 'cell') {
            place(ctx, 640, 320, { type: 'sheetCell', spreadsheetId: ref.spreadsheetId, sheetId: ref.sheetId, cell: ref.cell, label: ref.label });
          } else {
            place(ctx, 1200, 680, { type: 'sheetChart', spreadsheetId: ref.spreadsheetId, sheetId: ref.sheetId, chartId: ref.chartId, label: ref.label });
          }
        }}
      />
    );
  }
  if (kind === 'workItem' || kind === 'progress') {
    return (
      <WorkItemPicker
        workspaceId={ctx.workspaceId}
        confirmLabel={confirmLabel}
        onCancel={close}
        onPick={(item) => {
          close();
          const label = `${item.key} ${item.title}`;
          if (kind === 'progress') place(ctx, 1600, 640, { type: 'workItemProgress', itemId: item.id, label });
          else place(ctx, 880, 400, { type: 'workItem', itemId: item.id, label });
        }}
      />
    );
  }
  if (kind === 'person') return <PersonPicker ctx={ctx} onClose={close} />;
  return (
    <DocumentPicker
      workspaceId={ctx.workspaceId}
      confirmLabel={confirmLabel}
      onCancel={close}
      onPick={(doc) => {
        close();
        place(ctx, 960, 640, { type: 'link', documentId: doc.id, title: doc.title });
      }}
    />
  );
}

/** Chooses a member of the workspace for a person card. */
function PersonPicker({ ctx, onClose }: { ctx: SlideEditorContext; onClose: () => void }) {
  const members = useMembers(ctx.workspaceId).data ?? [];
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const matches = members.filter((m) => !m.disabled && (m.name.toLowerCase().includes(needle) || m.email.toLowerCase().includes(needle))).slice(0, 50);
  const pick = (member: WorkspaceMember) => {
    onClose();
    place(ctx, 1100, 360, { type: 'person', userId: member.userId, label: member.name });
  };
  return (
    <Modal
      title="Show a person"
      description="Their picture, name and role, as their profile has them."
      onClose={onClose}
      footer={
        <Button variant="subtle" className="text-xs" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && matches[0]) {
            e.preventDefault();
            pick(matches[0]);
          }
        }}
        placeholder="Search by name or email"
        className="w-full rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2.5 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />
      <ul className="scroll-thin mt-2 max-h-72 overflow-y-auto rounded-md border border-[var(--color-line)]">
        {matches.map((member) => (
          <li key={member.userId}>
            <button onClick={() => pick(member)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-surface)]">
              <Avatar name={member.name} url={member.avatarUrl} seed={member.userId} size="md" />
              <span className="min-w-0 flex-1 truncate">{member.name}</span>
              <span className="truncate text-xs text-[var(--color-muted)]">{member.workspaceRole.name}</span>
            </button>
          </li>
        ))}
        {members.length > 0 && matches.length === 0 && <li className="px-3 py-2 text-xs text-[var(--color-muted)]">Nobody matches.</li>}
      </ul>
    </Modal>
  );
}

/** Chooses a document from those the reader can open, searched by title as it is typed. */
export function DocumentPicker({
  workspaceId,
  confirmLabel,
  title = 'Show a document',
  description = 'Its opening text is shown on the slide and stays current.',
  onPick,
  onCancel,
}: {
  workspaceId: string;
  confirmLabel: string;
  title?: string;
  description?: string;
  onPick: (doc: { id: string; title: string }) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query.trim(), 150);
  const targets = useLinkTargets(workspaceId, debounced, { kinds: ['documents'], limit: 20 });
  const [cursor, setCursor] = useState(0);
  const items = (targets.data?.documents ?? []).filter((d) => d.mode !== 'canvas');
  useEffect(() => setCursor(0), [debounced]);
  const chosen = items[cursor];
  return (
    <Modal
      title={title}
      description={description}
      onClose={onCancel}
      wide
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" className="text-xs" disabled={!chosen} onClick={() => chosen && onPick(chosen)}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setCursor((c) => Math.min(c + 1, items.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, 0));
          } else if (e.key === 'Enter' && chosen) {
            e.preventDefault();
            onPick(chosen);
          }
        }}
        placeholder="Search by title"
        className="w-full rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2.5 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />
      <ul className="scroll-thin mt-2 max-h-72 overflow-y-auto rounded-md border border-[var(--color-line)]">
        {items.map((doc, index) => (
          <li key={doc.id}>
            <button
              onMouseEnter={() => setCursor(index)}
              onClick={() => setCursor(index)}
              onDoubleClick={() => onPick(doc)}
              className={cx(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
                index === cursor ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-surface)]',
              )}
            >
              {doc.icon ? <span className="text-xs">{doc.icon}</span> : <Icon name="file-earmark-text" className="text-xs" />}
              <span className="min-w-0 flex-1 truncate">{doc.title || 'Untitled'}</span>
            </button>
          </li>
        ))}
        {targets.isSuccess && items.length === 0 && <li className="px-3 py-2 text-xs text-[var(--color-muted)]">No documents match.</li>}
      </ul>
    </Modal>
  );
}

registerSlideInsertTool({ id: 'sheet-chart', label: 'Spreadsheet chart', icon: 'bar-chart', order: 50, run: (ctx) => ask('chart', ctx) });
registerSlideInsertTool({ id: 'sheet-cell', label: 'Spreadsheet cell', icon: 'table', order: 51, run: (ctx) => ask('cell', ctx) });
registerSlideInsertTool({ id: 'work-item', label: 'Work item', icon: 'kanban', order: 52, run: (ctx) => ask('workItem', ctx) });
registerSlideInsertTool({ id: 'document-excerpt', label: 'Document', icon: 'file-earmark-text', order: 53, run: (ctx) => ask('document', ctx) });
registerSlideInsertTool({ id: 'work-item-progress', label: 'Work item progress', icon: 'bar-chart-steps', order: 54, run: (ctx) => ask('progress', ctx) });
registerSlideInsertTool({ id: 'person', label: 'Person', icon: 'person-badge', order: 55, run: (ctx) => ask('person', ctx) });

// ---------------------------------------------------------------------------
// Pasting from a canvas
// ---------------------------------------------------------------------------

/** What a canvas puts on the clipboard when elements are copied. */
export const CANVAS_CLIP_MIME = 'application/x-paradocs-canvas';

/** Elements of a canvas copy, or null when the clipboard holds none. Another page wrote it, so only well-formed elements are kept. */
export function parseCanvasClip(raw: string | undefined): CanvasElement[] | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { elements?: unknown };
    if (!value || !Array.isArray(value.elements)) return null;
    const elements = value.elements.filter(
      (el): el is CanvasElement =>
        !!el && typeof el === 'object' && typeof (el as CanvasElement).type === 'string' && [el.x, el.y, el.width, el.height].every((n) => Number.isFinite(n)),
    );
    return elements.length ? elements.slice(0, 200) : null;
  } catch {
    return null;
  }
}

/** Puts a canvas selection on a slide, scaled to fit it. Returns the new element ids. */
export function pasteCanvasSelection(actions: SlidesActions, slideId: string, size: SlideSize, source: CanvasElement[]): string[] {
  const region = boardBounds(source);
  if (!region) return [];
  const converted: SlideElement[] = canvasElementsToSlide(source, region, size, { limitScale: true });
  // Pasting gives every element a new id, so connectors are laid after the boxes they join.
  const boxes = converted.filter((el) => el.type !== 'connector');
  const created = actions.pasteElements(slideId, boxes, 0);
  const renamed = new Map(boxes.map((el, i) => [el.id, created[i]]));
  const links = converted.filter((el) => el.type === 'connector').map((el) => ({ ...el, from: renamed.get((el as { from: string }).from), to: renamed.get((el as { to: string }).to) }));
  return [...created, ...(links.length ? actions.pasteElements(slideId, links as SlideElement[], 0) : [])];
}
