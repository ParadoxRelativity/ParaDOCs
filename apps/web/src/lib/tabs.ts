import { useSyncExternalStore } from 'react';
import { randomId } from './util';

/**
 * Tabs.
 *
 * A tab is a place in the app, not a copy of it: it holds the path it is
 * showing, and switching tabs is a navigation. That is what lets one tab sit on
 * a document while another is in chat, in a different workspace — the workspace
 * is part of the path, so the sidebar and everything else follow from whichever
 * tab is in front.
 *
 * Only the tab in front is mounted. A browser keeps every tab's page alive;
 * doing that here would mean a live collaboration session and chat socket per
 * tab, which is a lot of machinery to keep warm for something nobody is
 * looking at. What a background tab keeps instead is its path and the name it
 * had when you left it, which is enough to go back to and enough to label.
 *
 * The call is deliberately not in here. It belongs to the session rather than
 * to any tab, so it keeps running whichever tab you move to — the same reason
 * it survives walking off to read a document.
 */

export type TabKind = 'page' | 'canvas' | 'sheet' | 'chat' | 'project' | 'all' | 'access' | 'home';

export interface Tab {
  id: string;
  /** The in-app path this tab is showing. */
  path: string;
  /** Which workspace it is in, so the bar can group and label by it. */
  workspaceId: string;
  kind: TabKind;
  /**
   * What to write on the tab. Snapshotted, because a background tab may be in
   * a workspace this page has not loaded and has no way to ask about. The tab
   * in front keeps its label current.
   */
  label: string;
  /** A document's own icon, when it has one. */
  emoji?: string;
}

interface State {
  tabs: Tab[];
  activeId: string | null;
}

/** Enough that nobody meets it by accident, few enough that the bar stays usable. */
const MAX_TABS = 24;
const STORAGE_KEY = 'paradocs.tabs';

const UUID = '[0-9a-fA-F-]{36}';
const WORKSPACE_PATH = new RegExp(
  `^/w/(${UUID})(?:/(d|c|s|all)(?:/(${UUID}))?|/(access|people)(?:/[a-z]+)?|/(p)(?:/${UUID}(?:/${UUID})?)?)?/?$`,
);

/** What a path is, as far as a tab is concerned. Null for anything not tabbable. */
export function describePath(path: string): { workspaceId: string; kind: TabKind } | null {
  const match = WORKSPACE_PATH.exec(path.split('?')[0]);
  if (!match) return null;
  const [, workspaceId, section, , access, projects] = match;
  // Projects, with a project and perhaps one of its items open.
  if (projects) return { workspaceId, kind: 'project' };
  // The Access app names its pages rather than numbering them. It was once
  // called People, and a tab saved then still opens it.
  if (access) return { workspaceId, kind: 'access' };
  if (section === 'd') return { workspaceId, kind: 'page' };
  if (section === 'c') return { workspaceId, kind: 'chat' };
  // Spreadsheets are their own app, under their own letter.
  if (section === 's') return { workspaceId, kind: 'sheet' };
  if (section === 'all') return { workspaceId, kind: 'all' };
  return { workspaceId, kind: 'home' };
}

// --- the store --------------------------------------------------------------

let state: State = load();
const listeners = new Set<() => void>();

function load(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<State>) : null;
    const tabs = Array.isArray(parsed?.tabs)
      ? parsed!.tabs
          .filter(isTab)
          .slice(0, MAX_TABS)
          // A tab saved while Access was called People takes the new name.
          .map((tab) => (describePath(tab.path)?.kind === 'access' ? { ...tab, kind: 'access' as const } : tab))
      : [];
    const activeId = tabs.some((t) => t.id === parsed?.activeId) ? parsed!.activeId! : (tabs[0]?.id ?? null);
    return { tabs, activeId };
  } catch {
    return { tabs: [], activeId: null };
  }
}

function isTab(value: unknown): value is Tab {
  if (!value || typeof value !== 'object') return false;
  const tab = value as Partial<Tab>;
  // A stored path is replayed as a route, so it is checked rather than trusted:
  // page storage is not somewhere only this app writes.
  return (
    typeof tab.id === 'string' &&
    typeof tab.path === 'string' &&
    typeof tab.label === 'string' &&
    describePath(tab.path) !== null
  );
}

function commit(next: State): void {
  state = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage can be blocked or full; the tabs still work for this session.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => state;

export function useTabState(): State {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// --- what can be done to them ------------------------------------------------

function makeTab(path: string, label: string, emoji?: string): Tab | null {
  const described = describePath(path);
  if (!described) return null;
  return {
    id: randomId(),
    path,
    workspaceId: described.workspaceId,
    kind: described.kind,
    label,
    ...(emoji ? { emoji } : {}),
  };
}

/**
 * Opens a path in a tab of its own. A path already open is raised rather than
 * opened twice — two tabs on one document is two places for the same edit to
 * appear, which reads as a bug however it was asked for.
 */
export function openTab(path: string, label = '', options: { background?: boolean; emoji?: string } = {}): void {
  const existing = state.tabs.find((tab) => tab.path === path);
  if (existing) {
    if (!options.background) commit({ ...state, activeId: existing.id });
    return;
  }

  const tab = makeTab(path, label, options.emoji);
  if (!tab || state.tabs.length >= MAX_TABS) return;

  // New tabs land beside the one they came from, not at the far end, so a tab
  // opened from another is next to it.
  const index = state.tabs.findIndex((t) => t.id === state.activeId);
  const tabs = [...state.tabs];
  tabs.splice(index === -1 ? tabs.length : index + 1, 0, tab);
  commit({ tabs, activeId: options.background ? state.activeId : tab.id });
}

/**
 * The new-tab button: always a fresh tab, at the far end, the way a browser's
 * does it. Unlike `openTab` it does not raise a tab already on the path — the
 * path is only a starting point, and a workspace's front door being open
 * somewhere is no reason the button should do nothing.
 */
export function openNewTab(path: string): void {
  const tab = makeTab(path, '');
  if (!tab || state.tabs.length >= MAX_TABS) return;
  commit({ tabs: [...state.tabs, tab], activeId: tab.id });
}

export function activateTab(id: string): void {
  if (!state.tabs.some((tab) => tab.id === id)) return;
  commit({ ...state, activeId: id });
}

export function closeTab(id: string): void {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  // Closing the tab in front hands over to its right-hand neighbour, or its
  // left when it was the last one — where the eye already is.
  const activeId =
    state.activeId === id ? (tabs[index]?.id ?? tabs[index - 1]?.id ?? null) : state.activeId;
  commit({ tabs, activeId });
}

export function closeOtherTabs(id: string): void {
  const kept = state.tabs.find((tab) => tab.id === id);
  if (!kept) return;
  commit({ tabs: [kept], activeId: kept.id });
}

/** Drag-reorder: the tab at `from` ends up at `to`. */
export function moveTab(from: number, to: number): void {
  if (from === to || from < 0 || to < 0 || from >= state.tabs.length || to >= state.tabs.length) return;
  const tabs = [...state.tabs];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(to, 0, moved);
  commit({ ...state, tabs });
}

/**
 * Keeps the tab in front describing where it actually is. Called as the app
 * navigates and as the view works out what it is showing, so a tab follows a
 * rename and a move between documents without anything having to tell it twice.
 */
export function updateActiveTab(patch: Partial<Omit<Tab, 'id'>>): void {
  const active = state.tabs.find((tab) => tab.id === state.activeId);
  if (!active) return;
  // A tab that has navigated somewhere else belongs to wherever it landed, so
  // the workspace and the kind come from the new path rather than from whoever
  // happened to set it. An explicit patch still wins: the view knows a page
  // from a canvas, which the path alone does not say.
  const moved = patch.path && patch.path !== active.path ? describePath(patch.path) : null;
  // Going somewhere new drops the old name rather than carrying it until the
  // new one loads, which otherwise labels a tab with the document you just left.
  const next: Tab = moved
    ? { ...active, ...moved, label: '', emoji: undefined, ...patch }
    : { ...active, ...patch };
  // A document can lose its icon, so an absent one is an absent key.
  if (!next.emoji) delete next.emoji;
  if (
    next.path === active.path &&
    next.label === active.label &&
    next.kind === active.kind &&
    next.emoji === active.emoji &&
    next.workspaceId === active.workspaceId
  ) {
    return;
  }
  commit({ ...state, tabs: state.tabs.map((tab) => (tab.id === active.id ? next : tab)) });
}

/**
 * Makes sure there is a tab for where the app currently is. Called on the first
 * render, and again if every tab is closed: the app is always somewhere, so
 * there is always at least one tab.
 */
export function ensureTabFor(path: string, label = ''): void {
  if (state.tabs.length > 0 && state.activeId) return;
  const tab = makeTab(path, label);
  if (!tab) return;
  commit({ tabs: [...state.tabs, tab], activeId: tab.id });
}

/** What to tell people to hold, in the language of the machine they are on. */
export const MODIFIER =
  typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent)
    ? '\u2318'
    : 'Ctrl';

/**
 * Whether a click asked for a new tab rather than for this one to move: the
 * platform modifier, or the middle button. Call sites use it where a browser
 * would, so the gesture people already have works on the app's own lists.
 */
export function asksForNewTab(event: { metaKey?: boolean; ctrlKey?: boolean; button?: number }): boolean {
  return Boolean(event.metaKey) || Boolean(event.ctrlKey) || event.button === 1;
}

export function activeTab(): Tab | null {
  return state.tabs.find((tab) => tab.id === state.activeId) ?? null;
}
