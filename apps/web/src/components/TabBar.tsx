import { useEffect, useRef, useState } from 'react';
import type { WorkspaceSummary } from '../api/hooks';
import {
  activateTab,
  closeOtherTabs,
  closeTab,
  moveTab,
  useTabState,
  type Tab,
  type TabKind,
} from '../lib/tabs';
import { cx } from '../lib/util';
import Icon, { type IconName } from './Icon';
import WorkspaceIcon from './WorkspaceIcon';

const KIND_ICON: Record<TabKind, IconName> = {
  page: 'file-earmark-text',
  canvas: 'easel',
  sheet: 'table',
  chat: 'chat-dots',
  all: 'collection',
  people: 'people',
  home: 'house',
};

const KIND_FALLBACK: Record<TabKind, string> = {
  page: 'Document',
  canvas: 'Canvas',
  sheet: 'Spreadsheet',
  chat: 'Chat',
  all: 'All documents',
  people: 'People',
  home: 'Workspace',
};

/**
 * The strip of tabs across the top of the window.
 *
 * It sits above the sidebar rather than beside the content, because a tab can
 * be in a different workspace and the sidebar belongs to whichever workspace is
 * in front. Putting the bar inside the workspace layout would have it appear to
 * belong to a workspace it can leave.
 *
 * Each tab is marked with the workspace it is in whenever more than one is
 * open, so switching to a tab never silently moves you somewhere else.
 */
export default function TabBar({
  workspaces,
  onNewTab,
}: {
  /** For naming and picturing the workspace a tab is in. */
  workspaces: WorkspaceSummary[];
  onNewTab: () => void;
}) {
  const { tabs, activeId } = useTabState();
  const [dragging, setDragging] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const strip = useRef<HTMLDivElement>(null);

  // Only worth marking which workspace a tab is in when they are not all in
  // the same one; otherwise it is the same badge on every tab.
  const mixed = new Set(tabs.map((tab) => tab.workspaceId)).size > 1;
  const hasTabs = tabs.length > 0;

  // Once the tabs no longer fit, the one in front is kept in view: opening a
  // tab at the far end, or switching from a menu, should not leave it scrolled
  // off the edge.
  useEffect(() => {
    const active = strip.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [activeId, tabs.length]);

  // The strip scrolls sideways, but most mice only have a vertical wheel.
  // Attached by hand because React's wheel listener is passive and cannot
  // stop the page from scrolling too.
  useEffect(() => {
    const element = strip.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (element.scrollWidth <= element.clientWidth) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      element.scrollLeft += event.deltaY;
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [hasTabs]);

  if (!hasTabs) return null;

  return (
    <div className="flex h-9 shrink-0 items-stretch gap-1 border-b border-[var(--color-line)] bg-[var(--color-surface)] px-1.5">
      {/* Sized to its tabs rather than stretched, so the new-tab button sits
          just after the last one and only reaches the edge once they fill the
          bar. Past that the tabs narrow, and past their narrowest they scroll. */}
      <div ref={strip} role="tablist" aria-label="Open tabs" className="scroll-none flex min-w-0 items-stretch gap-1 overflow-x-auto">
        {tabs.map((tab, index) => (
          <TabButton
            key={tab.id}
            tab={tab}
            index={index}
            active={tab.id === activeId}
            workspace={workspaces.find((w) => w.id === tab.workspaceId)}
            showWorkspace={mixed}
            closable={tabs.length > 1}
            dragging={dragging === tab.id}
            onDragStart={() => setDragging(tab.id)}
            onDragEnd={() => setDragging(null)}
            onDropBefore={(from) => moveTab(from, index)}
            menuOpen={menuFor === tab.id}
            onMenu={(open) => setMenuFor(open ? tab.id : null)}
          />
        ))}
      </div>

      <button
        onClick={onNewTab}
        title="New tab"
        aria-label="New tab"
        className="my-1 grid w-7 shrink-0 place-items-center rounded-md text-[var(--color-muted)] hover:bg-[var(--color-line)]/60 hover:text-[var(--color-ink)]"
      >
        <Icon name="plus-lg" />
      </button>
    </div>
  );
}

function TabButton({
  tab,
  index,
  active,
  workspace,
  showWorkspace,
  closable,
  dragging,
  onDragStart,
  onDragEnd,
  onDropBefore,
  menuOpen,
  onMenu,
}: {
  tab: Tab;
  index: number;
  active: boolean;
  workspace: WorkspaceSummary | undefined;
  showWorkspace: boolean;
  closable: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropBefore: (from: number) => void;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
}) {
  const label = tab.label || KIND_FALLBACK[tab.kind];
  // A workspace this page has not loaded — one on another server, or one left
  // over from before losing access — still names itself as best it can.
  const workspaceName = workspace?.name;
  // The menu is placed against the window rather than the tab: the strip
  // scrolls, and a scrolling box clips anything that hangs out of it.
  const [menuAt, setMenuAt] = useState<{ left: number; top: number } | null>(null);

  return (
    <div
      // Tabs give up width together as the bar fills, down to enough to still
      // tell one from another; past that the strip scrolls instead.
      className={cx('group relative flex min-w-24 shrink items-center', dragging && 'opacity-40')}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(index));
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const from = Number(event.dataTransfer.getData('text/plain'));
        if (Number.isInteger(from)) onDropBefore(from);
        onDragEnd();
      }}
    >
      <button
        role="tab"
        aria-selected={active}
        title={workspaceName ? `${label} — ${workspaceName}` : label}
        onClick={() => activateTab(tab.id)}
        // Middle-click closes a tab, the way it does in a browser.
        onAuxClick={(event) => {
          if (event.button === 1 && closable) {
            event.preventDefault();
            closeTab(tab.id);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          setMenuAt({ left: rect.left + 8, top: rect.bottom });
          onMenu(!menuOpen);
        }}
        className={cx(
          'my-1 flex w-full min-w-0 max-w-52 items-center gap-1.5 rounded-md py-1 pl-2 text-xs',
          closable ? 'pr-6' : 'pr-2',
          active
            ? 'bg-[var(--color-canvas)] font-medium text-[var(--color-ink)] shadow-sm'
            : 'text-[var(--color-muted)] hover:bg-[var(--color-line)]/50 hover:text-[var(--color-ink)]',
        )}
      >
        {showWorkspace && (
          <span className="shrink-0">
            <WorkspaceIcon
              name={workspaceName ?? '?'}
              icon={workspace?.icon ?? null}
              avatarUrl={workspace?.avatarUrl ?? null}
              size="sm"
            />
          </span>
        )}
        <span className="shrink-0 text-[11px]">
          {tab.emoji ?? <Icon name={KIND_ICON[tab.kind]} />}
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>

      {closable && (
        <button
          onClick={() => closeTab(tab.id)}
          title={`Close ${label}`}
          aria-label={`Close ${label}`}
          className={cx(
            'absolute right-1 grid h-5 w-5 place-items-center rounded text-[10px]',
            'text-[var(--color-muted)] hover:bg-[var(--color-line)] hover:text-[var(--color-ink)]',
            // Always visible on the tab in front; on the rest it waits for the
            // pointer, so a row of tabs is names rather than crosses.
            active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
          )}
        >
          <Icon name="x-lg" />
        </button>
      )}

      {menuOpen && menuAt && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => onMenu(false)} />
          <div
            style={menuAt}
            className="fixed z-40 w-44 overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] py-1 text-xs shadow-xl">
            <MenuItem
              label="Close tab"
              disabled={!closable}
              onClick={() => {
                onMenu(false);
                closeTab(tab.id);
              }}
            />
            <MenuItem
              label="Close other tabs"
              disabled={!closable}
              onClick={() => {
                onMenu(false);
                closeOtherTabs(tab.id);
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="flex w-full px-3 py-1.5 text-left hover:bg-[var(--color-surface)] disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {label}
    </button>
  );
}
