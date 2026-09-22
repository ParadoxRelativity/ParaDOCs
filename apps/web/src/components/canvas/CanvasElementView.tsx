import { useEffect, useRef, useState } from 'react';
import {
  dashArray,
  shapePolygon,
  toEmbedUrl,
  type CanvasElement,
  type MindNodeElement,
  type ShapeElement,
} from '@paradocs/shared';
import type { WorkspaceMember } from '@paradocs/shared';
import { cx } from '../../lib/util';
import { assetUrl } from '../../lib/server';
import EmbeddedDocument from './EmbeddedDocument';
import { SheetCellCard, SheetChartCard } from '../sheet/SheetRefViews';
import { WorkItemCard } from '../projects/WorkItemRefs';
import {
  MentionPicker,
  applyMention,
  mentionQueryAt,
  renderMentionText,
  useMemberNames,
  type MentionPick,
} from './MentionText';

interface Props {
  element: CanvasElement;
  selected: boolean;
  /** True while this element is in text-editing mode (entered by double-click). */
  editing: boolean;
  dark: boolean;
  /** Who can be tagged in this element's text, and whose names tags resolve to. */
  members: WorkspaceMember[];
  onChange: (patch: Partial<CanvasElement>) => void;
  onStopEditing: () => void;
  onOpenDocument: (documentId: string) => void;
}

export default function CanvasElementView({
  element,
  selected,
  editing,
  dark,
  members,
  onChange,
  onStopEditing,
  onOpenDocument,
}: Props) {
  switch (element.type) {
    case 'note':
      return (
        <EditableText
          value={element.text}
          editing={editing}
          placeholder="Double-click to write"
          members={members}
          onChange={(text) => onChange({ text } as Partial<CanvasElement>)}
          onStopEditing={onStopEditing}
          className="h-full w-full resize-none rounded-lg p-3 text-sm leading-snug text-zinc-900 outline-none"
          style={{ background: element.color ?? '#fde68a' }}
        />
      );

    case 'text':
      return (
        <EditableText
          value={element.text}
          editing={editing}
          placeholder="Double-click to write"
          members={members}
          onChange={(text) => onChange({ text } as Partial<CanvasElement>)}
          onStopEditing={onStopEditing}
          className="h-full w-full resize-none bg-transparent font-medium outline-none"
          style={{ color: element.color ?? 'var(--color-ink)', fontSize: element.fontSize ?? 20 }}
        />
      );

    case 'node':
      return (
        <MindNode
          element={element}
          editing={editing}
          selected={selected}
          members={members}
          onChange={onChange}
          onStopEditing={onStopEditing}
        />
      );

    case 'frame':
      return (
        <div
          className={cx(
            'h-full w-full rounded-lg border-2 border-dashed',
            selected ? 'border-[var(--color-accent)]' : 'border-[var(--color-line)]',
          )}
          style={{ background: 'color-mix(in srgb, var(--color-surface) 55%, transparent)' }}
        >
          {editing && (
            <input
              autoFocus
              value={element.name}
              // A new frame arrives called "Frame 3", which is a suggestion
              // rather than a name: selecting it means typing replaces it
              // instead of landing after it.
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => onChange({ name: e.target.value } as Partial<CanvasElement>)}
              onBlur={onStopEditing}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') onStopEditing();
              }}
              className="m-2 rounded border border-[var(--color-accent)] bg-[var(--color-canvas)] px-2 py-1 text-sm outline-none"
            />
          )}
        </div>
      );

    case 'link':
      return (
        <EmbeddedDocument
          documentId={element.documentId}
          fallbackTitle={element.title}
          editing={editing}
          dark={dark}
          onOpenFullPage={() => onOpenDocument(element.documentId)}
        />
      );

    case 'embed':
      return <Embed element={element} interactive={selected} />;

    case 'sheetCell':
      return (
        <SheetCellCard
          spreadsheetId={element.spreadsheetId}
          sheetId={element.sheetId}
          cell={element.cell}
          label={element.label}
        />
      );

    case 'workItem':
      return <WorkItemCard itemId={element.itemId} label={element.label} interactive={editing} />;

    case 'sheetChart':
      return (
        <SheetChartCard
          fill
          spreadsheetId={element.spreadsheetId}
          sheetId={element.sheetId}
          chartId={element.chartId}
          label={element.label}
        />
      );

    case 'image':
      return element.url ? (
        <img
          src={assetUrl(element.url)}
          alt={element.alt ?? ''}
          draggable={false}
          className="h-full w-full rounded-lg object-cover"
        />
      ) : (
        <Placeholder label="Image" />
      );

    case 'audio':
      return (
        <div className="flex h-full w-full flex-col justify-center gap-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] px-3">
          {element.title && <span className="truncate text-xs font-medium">{element.title}</span>}
          <audio src={assetUrl(element.url)} controls draggable={false} className="w-full" />
        </div>
      );

    case 'video':
      return element.url ? (
        <video
          src={assetUrl(element.url)}
          controls
          draggable={false}
          // The surface keeps the controls inert until the element is selected,
          // so a press on an unselected video still selects and drags it.
          className="h-full w-full rounded-lg bg-black object-contain"
        />
      ) : (
        <Placeholder label="Video" />
      );

    case 'shape':
      return (
        <Shape
          element={element}
          editing={editing}
          selected={selected}
          members={members}
          onChange={onChange}
          onStopEditing={onStopEditing}
        />
      );

    default:
      return null;
  }
}

/**
 * Shapes are drawn as SVG sized to the element box, so the outline scales with
 * a resize while the stroke keeps a constant width. Edge styling mirrors the
 * connector options: colour, width and solid/dashed/dotted.
 */
function Shape({
  element,
  editing,
  selected,
  members,
  onChange,
  onStopEditing,
}: {
  element: ShapeElement;
  editing: boolean;
  selected: boolean;
  members: WorkspaceMember[];
  onChange: (patch: Partial<CanvasElement>) => void;
  onStopEditing: () => void;
}) {
  const width = Math.max(1, element.width);
  const height = Math.max(1, element.height);
  const fill = element.fill ?? 'transparent';
  const stroke = element.stroke ?? 'var(--color-muted)';
  const strokeWidth = element.strokeWidth ?? 2;
  const dash = dashArray(element.dash ?? 'solid', strokeWidth);
  const common = {
    fill,
    stroke,
    strokeWidth,
    strokeDasharray: dash,
    strokeLinejoin: 'round' as const,
  };

  return (
    <div className="relative h-full w-full">
      <svg
        className="absolute inset-0 h-full w-full overflow-visible"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
      >
        {element.shape === 'ellipse' ? (
          <ellipse
            cx={width / 2}
            cy={height / 2}
            rx={Math.max(0, width / 2 - strokeWidth / 2)}
            ry={Math.max(0, height / 2 - strokeWidth / 2)}
            {...common}
          />
        ) : element.shape === 'rectangle' ? (
          <rect
            x={strokeWidth / 2}
            y={strokeWidth / 2}
            width={Math.max(0, width - strokeWidth)}
            height={Math.max(0, height - strokeWidth)}
            rx={6}
            {...common}
          />
        ) : (
          <polygon points={shapePolygon(element.shape, width, height)} {...common} />
        )}
      </svg>

      <div className="absolute inset-0 grid place-items-center p-3">
        <EditableText
          value={element.text ?? ''}
          editing={editing}
          // Only hint inside the selected shape, so a diagram of empty shapes
          // is not covered in placeholder text.
          placeholder={selected ? 'Double-click to write' : ''}
          members={members}
          onChange={(text) => onChange({ text } as Partial<CanvasElement>)}
          onStopEditing={onStopEditing}
          className="w-full resize-none bg-transparent text-center text-sm leading-snug outline-none"
          style={{ color: readableOn(fill) }}
        />
      </div>
    </div>
  );
}

/**
 * A mind-map node. Roots are filled with their colour and children are outlined
 * in it, so the shape of the tree reads at a glance without a legend.
 */
function MindNode({
  element,
  editing,
  selected,
  members,
  onChange,
  onStopEditing,
}: {
  element: MindNodeElement;
  editing: boolean;
  selected: boolean;
  members: WorkspaceMember[];
  onChange: (patch: Partial<CanvasElement>) => void;
  onStopEditing: () => void;
}) {
  const color = element.color ?? '#6366f1';
  const isRoot = !element.parentId;

  return (
    <div
      className={cx(
        'grid h-full w-full place-items-center rounded-xl px-3 py-2',
        isRoot ? 'shadow-sm' : 'border-2',
      )}
      style={
        isRoot
          ? { background: color, borderColor: color }
          : { background: 'var(--color-raised)', borderColor: color }
      }
    >
      <EditableText
        value={element.text}
        editing={editing}
        placeholder={selected ? 'Double-click to name' : ''}
        members={members}
        onChange={(text) => onChange({ text } as Partial<CanvasElement>)}
        onStopEditing={onStopEditing}
        className={cx(
          'w-full resize-none bg-transparent text-center text-sm leading-snug outline-none',
          isRoot ? 'font-semibold' : 'font-medium',
        )}
        style={{ color: isRoot ? readableOn(color) : 'var(--color-ink)' }}
      />
    </div>
  );
}

/**
 * Shape fills are fixed pastels that do not follow the theme, so text inside a
 * shape must contrast with the fill rather than with the app. Without this,
 * shape labels were near-white on a pale fill in dark mode.
 */
function readableOn(fill: string | undefined): string {
  if (!fill || fill === 'transparent') return 'var(--color-ink)';
  const hex = fill.replace('#', '');
  if (hex.length !== 6) return 'var(--color-ink)';
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? '#18181b' : '#ffffff';
}

function Placeholder({ label }: { label: string }) {
  return (
    <div className="grid h-full w-full place-items-center rounded-lg border border-dashed border-[var(--color-line)] text-xs text-[var(--color-muted)]">
      {label}
    </div>
  );
}

/** Embeds stay inert until selected, so an iframe cannot swallow a drag. */
function Embed({ element, interactive }: { element: CanvasElement & { type: 'embed' }; interactive: boolean }) {
  if (!element.url) return <Placeholder label="Embed" />;
  const src = toEmbedUrl(element.url);
  // Only a web page is framed; anything else could run script as this app.
  if (!src) return <Placeholder label="This embed is not a web address" />;
  return (
    <div className="relative h-full w-full overflow-hidden rounded-lg border border-[var(--color-line)] bg-black">
      <iframe
        src={src}
        title={element.title ?? element.url}
        className="h-full w-full"
        allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
        sandbox="allow-scripts allow-same-origin allow-popups allow-presentation allow-forms"
        referrerPolicy="no-referrer"
      />
      {!interactive && <div className="absolute inset-0" aria-hidden />}
    </div>
  );
}

function EditableText({
  value,
  editing,
  placeholder,
  members,
  onChange,
  onStopEditing,
  className,
  style,
}: {
  value: string;
  editing: boolean;
  placeholder: string;
  /** Who can be tagged here. Empty outside a workspace context. */
  members: WorkspaceMember[];
  onChange: (value: string) => void;
  onStopEditing: () => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const names = useMemberNames(members);
  /** The `@…` being typed, if the caret is in one. */
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  // Dismissing the list with Escape must not bring it straight back on the next
  // keystroke, so the `@` that was dismissed is remembered until the caret
  // leaves it.
  const dismissed = useRef<number | null>(null);

  // Take remote edits while not editing; never overwrite what is being typed.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (!editing) return;
    const el = ref.current;
    el?.focus();
    // Put the caret at the end rather than selecting everything.
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  // Nothing is being typed any more, so nothing can be half-typed.
  useEffect(() => {
    if (!editing) {
      setMention(null);
      dismissed.current = null;
    }
  }, [editing]);

  /** Re-reads the caret to decide whether a tag is being written there. */
  function syncMention(next: string, caret: number) {
    if (members.length === 0) return;
    const at = mentionQueryAt(next, caret);
    if (!at) {
      setMention(null);
      dismissed.current = null;
      return;
    }
    if (dismissed.current === at.start) {
      setMention(null);
      return;
    }
    setMention(at);
  }

  function pickMention(member: MentionPick) {
    if (!mention) return;
    const { text, caret } = applyMention(draft, mention, member);
    setMention(null);
    dismissed.current = null;
    publish(text);
    // The caret has to be put back after React has written the new value, or
    // the browser leaves it where the shorter text used to end.
    requestAnimationFrame(() => ref.current?.setSelectionRange(caret, caret));
  }

  // Publish while typing so collaborators see it, but debounced: a Yjs write per
  // keystroke re-renders the whole board.
  function publish(next: string) {
    setDraft(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange(next), 250);
  }

  function flush() {
    clearTimeout(timer.current);
    if (draft !== value) onChange(draft);
  }

  useEffect(() => () => clearTimeout(timer.current), []);

  if (!editing) {
    // Rendered as static text so it never captures pointer events. Tags are
    // drawn as the names they currently resolve to, not as their markup.
    return (
      <div className={cx(className, 'overflow-hidden whitespace-pre-wrap')} style={style}>
        {draft ? renderMentionText(draft, names) : <span className="opacity-40">{placeholder}</span>}
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <textarea
        ref={ref}
        value={draft}
        placeholder={placeholder}
        className={className}
        style={style}
        onChange={(e) => {
          publish(e.target.value);
          syncMention(e.target.value, e.target.selectionStart);
        }}
        // Clicking or arrowing elsewhere can move the caret out of a half-typed
        // tag, or back into one.
        onSelect={(e) => {
          const el = e.currentTarget;
          syncMention(el.value, el.selectionStart);
        }}
        onBlur={() => {
          flush();
          onStopEditing();
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          // While the list is open it owns the arrows, Enter and Escape; it
          // handles them in the capture phase, so anything arriving here is
          // meant for the text.
          if (e.key === 'Escape' && !mention) {
            flush();
            onStopEditing();
          }
        }}
      />
      {mention && (
        <MentionPicker
          members={members}
          query={mention.query}
          onPick={pickMention}
          onDismiss={() => {
            dismissed.current = mention.start;
            setMention(null);
          }}
        />
      )}
    </div>
  );
}
