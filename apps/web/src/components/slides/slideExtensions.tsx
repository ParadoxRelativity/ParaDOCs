import { createContext, type ComponentType, type ReactNode } from 'react';
import type * as Y from 'yjs';
import {
  resolveSlideColor,
  type CanvasElement,
  type SlideElement,
  type SlideElementType,
  type SlideSnapshot,
  type Theme,
  type WorkspaceMember,
} from '@paradocs/shared';
import type { CollabSession } from '../../lib/collaboration';
import type { SlidesActions } from '../../lib/slidesStore';
import type { IconName } from '../Icon';
import CanvasElementView from '../canvas/CanvasElementView';

/**
 * The seams later Slides stories plug into, so the editor itself never has to
 * know about rich text, tables, notes or the slideshow. Each registry is a
 * module-level list filled by importing a module for its side effect
 * (`import './richText'`), the way the built-ins are in slideBuiltins.tsx.
 *
 *   registerSlideElementRenderer  how an element type is drawn, edited and
 *                                 shown read-only (stage, thumbnails, the
 *                                 slideshow): rich text, tables, themed shapes
 *   registerSlideInsertTool       a button in the Insert group of the toolbar
 *   registerSlideToolbarAction    any other toolbar button (Present, ...)
 *   registerSlideInspectorSection a block in the right-hand inspector, for a
 *                                 slide or for the selected elements
 *   registerSlidePanel            a panel below the stage (speaker notes)
 */

export interface SlideElementRendererProps {
  element: SlideElement;
  theme: Theme;
  /** On the stage and selected, so an element can show its affordances. */
  selected: boolean;
  /** In text-editing mode: entered by double-click, left by Escape or a click elsewhere. */
  editing: boolean;
  /** Thumbnails and the slideshow: draw only, never mount an editor. */
  readOnly: boolean;
  members: WorkspaceMember[];
  /** Takes the element's id so one stable function serves every element, and memoising holds. */
  onUpdate: (id: string, patch: Record<string, unknown>) => void;
  onStopEditing: (id: string) => void;
}

/**
 * What an element renderer that edits collaborative content (a rich text box
 * binds an editor to its Y.XmlFragment) needs beyond its props: the document
 * and the slide it is on. Provided by the stage; absent in thumbnails and the
 * slideshow, where nothing is ever edited.
 */
export const SlideDocContext = createContext<{ ydoc: Y.Doc; slideId: string; actions: SlidesActions } | null>(null);

const renderers = new Map<string, ComponentType<SlideElementRendererProps>>();

export function registerSlideElementRenderer(type: SlideElementType, component: ComponentType<SlideElementRendererProps>) {
  renderers.set(type, component);
}

export function slideElementRenderer(type: string): ComponentType<SlideElementRendererProps> {
  return renderers.get(type) ?? CanvasBackedRenderer;
}

/** Color fields that may name a theme slot, resolved so the shared canvas renderers need know nothing of themes. */
const COLOR_FIELDS = ['color', 'fill', 'stroke'] as const;

export function resolveElementColors<T extends SlideElement>(element: T, theme: Theme): T {
  let copy: T | null = null;
  for (const field of COLOR_FIELDS) {
    const value = (element as unknown as Record<string, unknown>)[field];
    if (typeof value !== 'string') continue;
    const resolved = resolveSlideColor(value, theme);
    if (resolved !== value) {
      copy = copy ?? { ...element };
      (copy as unknown as Record<string, unknown>)[field] = resolved;
    }
  }
  return copy ?? element;
}

/** Elements that mean the same on a slide as on a board are drawn by the board's own renderer, unchanged. */
function CanvasBackedRenderer({ element, theme, selected, editing, readOnly, members, onUpdate, onStopEditing }: SlideElementRendererProps) {
  const known = ['text', 'shape', 'image', 'video', 'embed', 'sheetCell', 'sheetChart', 'workItem'];
  if (!known.includes(element.type)) {
    return (
      <div className="grid h-full w-full place-items-center rounded border border-dashed border-[var(--color-line)] text-xs text-[var(--color-muted)]">
        {element.type}
      </div>
    );
  }
  return (
    <CanvasElementView
      element={resolveElementColors(element, theme) as unknown as CanvasElement}
      selected={!readOnly && selected}
      editing={!readOnly && editing}
      // A slide is a page: it keeps its own colors in the app's dark theme.
      dark={false}
      members={members}
      onUpdate={onUpdate as (id: string, patch: Partial<CanvasElement>) => void}
      onStopEditing={onStopEditing}
      onOpenDocument={noop}
    />
  );
}

const noop = () => {};

// ---------------------------------------------------------------------------
// Editor context
// ---------------------------------------------------------------------------

/** What an extension is told about the editor when it renders or runs. */
export interface SlideEditorContext {
  presentationId: string;
  workspaceId: string;
  canEdit: boolean;
  session: CollabSession;
  slide: SlideSnapshot | null;
  /** Every slide in running order. */
  slides: SlideSnapshot[];
  /** Selected elements on the current slide. */
  selection: SlideElement[];
  theme: Theme;
  /** Every edit the editor makes, scoped to this person's undo history. */
  actions: SlidesActions;
  /** Selects elements on the stage (replacing the selection), e.g. the one just inserted. */
  select: (ids: string[]) => void;
  /** Puts an element into text-editing mode. */
  edit: (id: string | null) => void;
  /** The centre of the slide, where new things are inserted. */
  center: { x: number; y: number };
}

export interface SlideInsertTool {
  id: string;
  label: string;
  icon: IconName;
  /** Lower first. */
  order?: number;
  run: (ctx: SlideEditorContext) => void | Promise<void>;
}

export interface SlideToolbarAction {
  id: string;
  label: string;
  icon: IconName;
  order?: number;
  /** Shown to people who can only view, too (Present). Defaults to editors only. */
  viewers?: boolean;
  run: (ctx: SlideEditorContext) => void;
}

export interface SlideInspectorSection {
  id: string;
  order?: number;
  /** `slide` when nothing is selected, `elements` for a selection. */
  applies: (ctx: SlideEditorContext, scope: 'slide' | 'elements') => boolean;
  render: (ctx: SlideEditorContext) => ReactNode;
}

export interface SlidePanel {
  id: string;
  order?: number;
  render: (ctx: SlideEditorContext) => ReactNode;
}

/** Takes files pasted or dropped on the stage (pictures, video), the way an insert tool takes a click. */
export interface SlideFileHandler {
  id: string;
  order?: number;
  accepts: (file: File) => boolean;
  /** `at` is where on the slide a file was dropped, in slide units; absent for a paste. */
  run: (ctx: SlideEditorContext, files: File[], at?: { x: number; y: number }) => void | Promise<void>;
}

function registry<T extends { id: string; order?: number }>() {
  const items = new Map<string, T>();
  return {
    // Registering an id again replaces it, so a story can take over a built-in.
    register: (item: T) => void items.set(item.id, item),
    all: () => [...items.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)),
  };
}

const insertTools = registry<SlideInsertTool>();
const toolbarActions = registry<SlideToolbarAction>();
const inspectorSections = registry<SlideInspectorSection>();
const panels = registry<SlidePanel>();
const fileHandlers = registry<SlideFileHandler>();

export const registerSlideInsertTool = insertTools.register;
export const registerSlideToolbarAction = toolbarActions.register;
export const registerSlideInspectorSection = inspectorSections.register;
export const registerSlidePanel = panels.register;
export const registerSlideFileHandler = fileHandlers.register;
export const slideFileHandlers = fileHandlers.all;

export const slideInsertTools = insertTools.all;
export const slideToolbarActions = toolbarActions.all;
export const slideInspectorSections = inspectorSections.all;
export const slidePanels = panels.all;
