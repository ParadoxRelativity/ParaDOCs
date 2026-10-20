import { memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import * as Y from 'yjs';
import { baseKeymap } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import { EditorState, Selection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { redo, undo, yUndoPlugin, ySyncPlugin, ySyncPluginKey } from 'y-prosemirror';
import {
  fontStack,
  listNumbers,
  resolveSlideColor,
  richTextBody,
  type RichParagraph,
  type RichTextElement,
  type Theme,
  type WorkspaceMember,
} from '@paradocs/shared';
import { MentionPicker, mentionQueryAt, useMemberNames, type MentionPick } from '../canvas/MentionText';
import { backspaceInList, indentCommand, numberingPlugin, splitParagraph, toggleSimpleMark } from './richTextCommands';
import { markStyle, paragraphStyle, px, richTextSchema, safeHref } from './richTextModel';
import { clearEditor, publishEditor } from './richTextSession';
import { SlideDocContext, registerSlideElementRenderer, type SlideElementRendererProps } from './slideExtensions';
import './slideText.css';

const PADDING = 12;
const DEFAULT_SIZE = 32;
const DEFAULT_LINE_SPACING = 1.2;
const MIN_FIT = 0.2;

/**
 * The box a rich text element's text sits in: its fill and outline, vertical
 * alignment, and autofit. Used by the editor and the read-only view alike, so
 * the text does not move when editing starts or stops.
 *
 * Autofit shrinks the text rather than letting it overflow: the box measures
 * its content at full size, and when that is taller than the box, searches for
 * the largest `--fit` (a multiplier every size in the box is written in terms
 * of) that makes it fit.
 */
function Frame({
  element,
  theme,
  readOnly,
  empty,
  refit,
  children,
}: {
  element: RichTextElement;
  theme: Theme;
  readOnly: boolean;
  empty: boolean;
  refit?: MutableRefObject<() => void>;
  children: ReactNode;
}) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const autofit = element.autofit !== false;

  const fit = useRef(() => {});
  fit.current = () => {
    const box = outer.current;
    const content = inner.current;
    if (!box || !content) return;
    box.style.setProperty('--fit', '1');
    if (!autofit) return;
    const available = box.clientHeight - PADDING * 2;
    if (available <= 0 || content.offsetHeight <= available + 0.5) return;
    let low = MIN_FIT;
    let high = 1;
    for (let i = 0; i < 9; i++) {
      const mid = (low + high) / 2;
      box.style.setProperty('--fit', String(mid));
      if (content.offsetHeight <= available + 0.5) low = mid;
      else high = mid;
    }
    box.style.setProperty('--fit', String(low));
  };
  if (refit) refit.current = () => fit.current();

  // Whenever what is drawn could have changed size, and again once web fonts arrive and reflow the text.
  useLayoutEffect(() => fit.current());
  useEffect(() => {
    const box = outer.current;
    if (!box) return;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => fit.current());
    observer?.observe(box);
    const onFonts = () => fit.current();
    document.fonts?.addEventListener?.('loadingdone', onFonts);
    return () => {
      observer?.disconnect();
      document.fonts?.removeEventListener?.('loadingdone', onFonts);
    };
  }, []);

  const heading = element.placeholderKind === 'title' || element.placeholder === 'title';
  const family = element.fontFamily ?? (heading ? theme.fonts.heading : theme.fonts.body);
  const style: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: element.verticalAlign === 'middle' ? 'center' : element.verticalAlign === 'bottom' ? 'flex-end' : 'flex-start',
    width: '100%',
    height: '100%',
    boxSizing: 'border-box',
    padding: PADDING,
    overflow: 'hidden',
    fontFamily: fontStack(family),
    fontSize: px(element.fontSize ?? DEFAULT_SIZE),
    lineHeight: element.lineSpacing ?? DEFAULT_LINE_SPACING,
    // Set outright: a thumbnail sits in a button that centres, a slide in a page that does not, and the text must not depend on either.
    textAlign: element.align ?? 'left',
    fontWeight: element.bold ? 700 : 400,
    fontStyle: element.italic ? 'italic' : 'normal',
    letterSpacing: 'normal',
    textTransform: 'none',
    color: resolveSlideColor(element.color ?? 'theme:text1', theme),
    background: element.fill && element.fill !== 'transparent' ? resolveSlideColor(element.fill, theme) : undefined,
    border: element.stroke ? `${element.strokeWidth ?? 2}px solid ${resolveSlideColor(element.stroke, theme)}` : undefined,
    ['--slide-link' as string]: theme.colors.hyperlink,
  };
  return (
    <div ref={outer} className="slide-text" style={style} data-rich-text>
      <div ref={inner} style={{ flex: 'none', position: 'relative' }} data-placeholder={!readOnly && empty ? (element.prompt ?? 'Click to add text') : undefined} className={!readOnly && empty ? 'slide-text-empty' : undefined}>
        {children}
      </div>
    </div>
  );
}

/** Read-only rich text: React drawn from the snapshot, so thumbnails and the slideshow mount no editor. */
function Paragraphs({ paragraphs, names, link }: { paragraphs: RichParagraph[]; names: Map<string, string>; link: boolean }) {
  const numbers = useMemo(() => listNumbers(paragraphs), [paragraphs]);
  return (
    <>
      {paragraphs.map((paragraph, i) => (
        <p key={i} className="slide-p" data-bullet={paragraph.bullet} data-num={numbers[i] ?? undefined} style={paragraphStyle(paragraph)}>
          {paragraph.runs.length === 0 ? (
            <br />
          ) : (
            paragraph.runs.map((run, r) => {
              if (run.mention) {
                return (
                  <span key={r} className="slide-mention">
                    @{names.get(run.mention.userId) ?? run.mention.label}
                  </span>
                );
              }
              const href = safeHref(run.marks?.link);
              const style = markStyle(run.marks);
              // A link is only followable where the slide is being read; on the stage a click selects it.
              return href && link ? (
                <a key={r} href={href} target="_blank" rel="noopener noreferrer" style={style}>
                  {run.text}
                </a>
              ) : (
                <span key={r} className={href ? 'slide-link' : undefined} style={style}>
                  {run.text}
                </span>
              );
            })
          )}
        </p>
      ))}
    </>
  );
}

const EMPTY: RichParagraph[] = [];

function RichTextView({ element, theme, members, readOnly }: { element: RichTextElement; theme: Theme; members: WorkspaceMember[]; readOnly: boolean }) {
  const names = useMemberNames(members);
  const paragraphs = element.paragraphs ?? EMPTY;
  const empty = !element.text?.trim() && !paragraphs.some((p) => p.runs.some((run) => run.mention));
  return (
    <Frame element={element} theme={theme} readOnly={readOnly} empty={empty}>
      <Paragraphs paragraphs={paragraphs} names={names} link={readOnly} />
    </Frame>
  );
}

/**
 * The text box while it is being edited: ProseMirror bound to the box's
 * Y.XmlFragment, so every keystroke is a collaborative edit and two people in
 * one box merge. Mounted only for the one box being edited.
 */
function RichTextEditor({
  element,
  theme,
  members,
  onStopEditing,
}: {
  element: RichTextElement;
  theme: Theme;
  members: WorkspaceMember[];
  onStopEditing: (id: string) => void;
}) {
  const doc = useContext(SlideDocContext);
  const mount = useRef<HTMLDivElement>(null);
  const refit = useRef(() => {});
  const names = useMemberNames(members);
  const live = useRef({ names, onStopEditing, id: element.id });
  live.current = { names, onStopEditing, id: element.id };
  const [empty, setEmpty] = useState(!element.text?.trim());
  const [mention, setMention] = useState<{ query: string; from: number; to: number } | null>(null);
  const dismissed = useRef<number | null>(null);
  const [view, setView] = useState<EditorView | null>(null);

  const fragment = doc ? richTextBody(doc.ydoc, doc.slideId, element.id) : null;

  useEffect(() => {
    if (!fragment || !mount.current) return;
    const id = element.id;
    const undoManager = new Y.UndoManager(fragment, { trackedOrigins: new Set([ySyncPluginKey]) });
    const stop = () => {
      live.current.onStopEditing(live.current.id);
      return true;
    };
    const state = EditorState.create({
      schema: richTextSchema,
      plugins: [
        ySyncPlugin(fragment),
        yUndoPlugin({ undoManager }),
        numberingPlugin(),
        keymap({
          'Mod-z': undo,
          'Mod-y': redo,
          'Mod-Shift-z': redo,
          'Mod-b': (_s, _d, v) => (v ? (toggleSimpleMark(v, 'bold'), true) : false),
          'Mod-i': (_s, _d, v) => (v ? (toggleSimpleMark(v, 'italic'), true) : false),
          'Mod-u': (_s, _d, v) => (v ? (toggleSimpleMark(v, 'underline'), true) : false),
          Enter: splitParagraph,
          'Shift-Enter': splitParagraph,
          Backspace: backspaceInList,
          Tab: indentCommand(1),
          'Shift-Tab': indentCommand(-1),
          Escape: stop,
        }),
        keymap(baseKeymap),
      ],
    });

    const afterUpdate = (v: EditorView) => {
      publishEditor(id, v);
      refit.current();
      setEmpty(v.state.doc.textContent.length === 0 && !hasMention(v.state));
      // An `@` just typed opens the member list at the caret.
      const { $from, empty: caret } = v.state.selection;
      const before = caret && $from.parent.isTextblock ? $from.parent.textBetween(0, $from.parentOffset, undefined, '￼') : '';
      const at = before ? mentionQueryAt(before, before.length) : null;
      if (!at) {
        dismissed.current = null;
        setMention(null);
      } else if (dismissed.current === $from.start() + at.start) setMention(null);
      else setMention({ query: at.query, from: $from.start() + at.start, to: $from.pos });
    };

    const editor = new EditorView(mount.current, {
      state,
      attributes: { 'aria-label': 'Slide text', 'aria-multiline': 'true', role: 'textbox' },
      nodeViews: {
        mention: (node) => {
          const dom = document.createElement('span');
          dom.className = 'slide-mention';
          dom.textContent = `@${live.current.names.get(node.attrs.userId) ?? node.attrs.label}`;
          return { dom };
        },
      },
      // `this`, not `editor`: the sync plugin dispatches while the view is still being constructed.
      dispatchTransaction(this: EditorView, tr) {
        this.updateState(this.state.apply(tr));
        afterUpdate(this);
      },
    });
    setView(editor);
    editor.focus();
    editor.dispatch(editor.state.tr.setSelection(Selection.atEnd(editor.state.doc)));
    afterUpdate(editor);

    return () => {
      editor.destroy();
      undoManager.destroy();
      clearEditor(id);
      setView(null);
    };
  }, [fragment, element.id]);

  const pick = (member: MentionPick) => {
    if (!view || !mention) return;
    const node = richTextSchema.nodes.mention.create({ userId: member.id, label: member.name });
    view.dispatch(view.state.tr.replaceWith(mention.from, mention.to, [node, richTextSchema.text(' ')]));
    setMention(null);
    view.focus();
  };

  // The member list floats at the caret, outside the box: the box clips, and the slide is scaled.
  const caret = mention && view ? view.coordsAtPos(mention.to) : null;

  return (
    <Frame element={element} theme={theme} readOnly={false} empty={empty} refit={refit}>
      <div ref={mount} />
      {mention && caret && members.length > 0 &&
        createPortal(
          <div style={{ position: 'fixed', left: caret.left, top: caret.bottom, zIndex: 60 }}>
            <MentionPicker
              members={members}
              query={mention.query}
              onPick={pick}
              onDismiss={() => {
                dismissed.current = mention.from;
                setMention(null);
              }}
            />
          </div>,
          document.body,
        )}
    </Frame>
  );
}

function hasMention(state: EditorState): boolean {
  let found = false;
  state.doc.descendants((node) => {
    if (node.type === richTextSchema.nodes.mention) found = true;
    return !found;
  });
  return found;
}

/** A snapshot of a box with a body carries its paragraphs; without them there is nothing to bind an editor to. */
const hasBody = (element: RichTextElement) => element.paragraphs !== undefined;

const RichTextRenderer = memo(function RichTextRenderer({ element, theme, editing, readOnly, members, onStopEditing }: SlideElementRendererProps) {
  const rich = element as RichTextElement;
  if (editing && !readOnly && hasBody(rich)) return <RichTextEditor element={rich} theme={theme} members={members} onStopEditing={onStopEditing} />;
  return <RichTextView element={rich} theme={theme} members={members} readOnly={readOnly} />;
});

registerSlideElementRenderer('richText', RichTextRenderer);
