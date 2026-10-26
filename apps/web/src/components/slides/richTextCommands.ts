import { toggleMark } from 'prosemirror-commands';
import { Plugin, type Command, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { MAX_LIST_LEVEL, listNumbers, type RichAlign, type RichBullet } from '@paradocs/shared';
import { richTextSchema } from './richTextModel';

/** What the formatting controls show for the cursor or selection, and what they do to it. */
export interface FormatState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color?: string;
  highlight?: string;
  fontSize?: number;
  fontFamily?: string;
  link?: string;
  align?: RichAlign;
  bullet?: RichBullet;
  level: number;
  lineHeight?: number;
}

const { marks: markTypes, nodes } = richTextSchema;

export function formatState(state: EditorState): FormatState {
  const { from, to, empty, $from } = state.selection;
  let marks = empty ? (state.storedMarks ?? $from.marks()) : [];
  if (!empty) {
    state.doc.nodesBetween(from, to, (node) => {
      if (node.isText && marks.length === 0) marks = node.marks;
    });
  }
  const attrOf = (name: string, attr: string) => marks.find((m) => m.type.name === name)?.attrs[attr] as string | undefined;
  let paragraph: { align?: RichAlign; bullet?: RichBullet; level: number; lineHeight?: number } = { level: 0 };
  let found = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (found || !node.isTextblock) return;
    found = true;
    const a = node.attrs;
    paragraph = {
      align: (a.align as RichAlign) ?? undefined,
      bullet: a.bullet === 'bullet' || a.bullet === 'number' ? a.bullet : undefined,
      level: Math.max(0, Math.round(Number(a.level)) || 0),
      lineHeight: Number(a.lineHeight) > 0 ? Number(a.lineHeight) : undefined,
    };
  });
  const size = Number(attrOf('fontSize', 'size'));
  return {
    bold: marks.some((m) => m.type === markTypes.bold),
    italic: marks.some((m) => m.type === markTypes.italic),
    underline: marks.some((m) => m.type === markTypes.underline),
    strike: marks.some((m) => m.type === markTypes.strike),
    color: attrOf('color', 'color'),
    highlight: attrOf('highlight', 'color'),
    fontSize: size > 0 ? size : undefined,
    fontFamily: attrOf('fontFamily', 'family'),
    link: attrOf('link', 'href'),
    ...paragraph,
  };
}

/** Sets a mark's value on the selection (or what is typed next), or with null removes it. */
export function setMark(view: EditorView, name: string, attrs: Record<string, unknown> | null) {
  const type = markTypes[name];
  const { from, to, empty } = view.state.selection;
  let tr = view.state.tr;
  if (empty) tr = attrs ? tr.addStoredMark(type.create(attrs)) : tr.removeStoredMark(type);
  else tr = attrs ? tr.addMark(from, to, type.create(attrs)) : tr.removeMark(from, to, type);
  view.dispatch(tr);
  view.focus();
}

export function toggleSimpleMark(view: EditorView, name: 'bold' | 'italic' | 'underline' | 'strike') {
  toggleMark(markTypes[name])(view.state, view.dispatch);
  view.focus();
}

/** Changes paragraph attributes on every paragraph the selection touches; a null clears one. */
export function setParagraph(view: EditorView, changes: Record<string, unknown>) {
  const { from, to } = view.state.selection;
  const tr = view.state.tr;
  view.state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type === nodes.paragraph) tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...changes });
  });
  view.dispatch(tr);
  view.focus();
}

/** Starts or stops a list: a selection already all in that kind of list leaves it. */
export function toggleList(view: EditorView, kind: RichBullet) {
  const { from, to } = view.state.selection;
  let all = true;
  view.state.doc.nodesBetween(from, to, (node) => {
    if (node.type === nodes.paragraph && node.attrs.bullet !== kind) all = false;
  });
  setParagraph(view, all ? { bullet: null, level: null } : { bullet: kind });
}

function levelOf(attrs: Record<string, unknown>): number {
  return Math.max(0, Math.round(Number(attrs.level)) || 0);
}

/** Moves list items in or out a level. */
export function shiftLevel(view: EditorView, delta: number) {
  const { from, to } = view.state.selection;
  const tr = view.state.tr;
  view.state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type !== nodes.paragraph || !node.attrs.bullet) return;
    const level = Math.min(Math.max(levelOf(node.attrs) + delta, 0), MAX_LIST_LEVEL);
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, level: level || null });
  });
  view.dispatch(tr);
  view.focus();
}

/** Enter splits the paragraph and keeps its list and alignment; Enter on an empty list item ends the list. */
export const splitParagraph: Command = (state, dispatch) => {
  const tr = state.tr;
  const marks = state.storedMarks ?? state.selection.$from.marks();
  if (!state.selection.empty) tr.deleteSelection();
  const $from = tr.selection.$from;
  const paragraph = $from.parent;
  if (paragraph.type !== nodes.paragraph) return false;
  if (paragraph.attrs.bullet && paragraph.content.size === 0) {
    tr.setNodeMarkup($from.before(), undefined, { ...paragraph.attrs, bullet: null, level: null });
  } else {
    tr.split($from.pos, 1, [{ type: nodes.paragraph, attrs: paragraph.attrs }]);
    tr.setStoredMarks(marks);
  }
  dispatch?.(tr.scrollIntoView());
  return true;
};

/** Backspace at the start of a list item steps out a level, then out of the list, before it joins the line above. */
export const backspaceInList: Command = (state, dispatch) => {
  const { empty, $from } = state.selection;
  if (!empty || $from.parentOffset !== 0 || !$from.parent.attrs.bullet) return false;
  const level = levelOf($from.parent.attrs);
  const attrs = level > 0 ? { ...$from.parent.attrs, level: level - 1 || null } : { ...$from.parent.attrs, bullet: null, level: null };
  dispatch?.(state.tr.setNodeMarkup($from.before(), undefined, attrs));
  return true;
};

export const indentCommand = (delta: number): Command => (state, dispatch, view) => {
  if (!state.selection.$from.parent.attrs.bullet) return false;
  if (view) shiftLevel(view, delta);
  else dispatch?.(state.tr);
  return true;
};

/**
 * Numbers each numbered paragraph by decoration, so the number is never stored
 * and follows edits and reordering. Also marks empty list items, which show no
 * bullet (as in PowerPoint) unless the caret is in one.
 */
export function numberingPlugin(): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const items: { pos: number; size: number; bullet?: RichBullet; level: number; empty: boolean }[] = [];
        state.doc.forEach((node, pos) => items.push({ pos, size: node.nodeSize, bullet: node.attrs.bullet, level: levelOf(node.attrs), empty: node.content.size === 0 }));
        const numbers = listNumbers(items);
        const caret = state.selection.$head.pos;
        const decorations = items.flatMap((item, i) => {
          const attrs: Record<string, string> = {};
          if (numbers[i] !== null) attrs['data-num'] = String(numbers[i]);
          if (item.bullet && item.empty && (caret <= item.pos || caret >= item.pos + item.size)) attrs['data-empty'] = '';
          return Object.keys(attrs).length ? [Decoration.node(item.pos, item.pos + item.size, attrs)] : [];
        });
        return DecorationSet.create(state.doc, decorations);
      },
    },
  });
}
