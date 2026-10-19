import { useEffect, useState, type ReactNode } from 'react';
import * as Y from 'yjs';
import { notesFragmentName } from '@paradocs/shared';
import { cx } from '../../lib/util';

/**
 * A slide's speaker notes, read-only and live: the same Y.XmlFragment the
 * notes editor writes (`notes:<slideId>` in the deck's Y.Doc), drawn without
 * mounting an editor. The presenter view (PARA-94) shows notes with this, so
 * what a collaborator types appears while presenting.
 *
 * It understands what the editor writes (BlockNote paragraphs, headings and
 * bulleted, numbered and checklist items, with bold, italic, underline,
 * strikethrough, code and links) and falls back to plain paragraphs for
 * anything else, so notes written by an import or another client still read.
 */
export default function SlideNotesView({
  ydoc,
  slideId,
  className,
  emptyText,
}: {
  ydoc: Y.Doc;
  slideId: string;
  className?: string;
  /** Shown when the slide has no notes. Nothing is shown by default. */
  emptyText?: string;
}) {
  const fragment = ydoc.getXmlFragment(notesFragmentName(slideId));
  const [, setVersion] = useState(0);

  useEffect(() => {
    const changed = () => setVersion((v) => v + 1);
    fragment.observeDeep(changed);
    return () => fragment.unobserveDeep(changed);
  }, [fragment]);

  const body = blocks(fragment.toArray() as Node[]);
  const empty = body.length === 0 || fragment.toArray().every(isBlank);
  if (empty) return emptyText ? <p className={cx('text-[var(--color-muted)]', className)}>{emptyText}</p> : null;
  return <div className={cx('space-y-1 break-words', className)}>{body}</div>;
}

type Node = Y.XmlElement | Y.XmlText | Y.XmlHook;

function isBlank(node: unknown): boolean {
  if (node instanceof Y.XmlText) return node.toString().trim() === '' && node.toDelta().every((op: { insert?: unknown }) => typeof op.insert === 'string');
  if (node instanceof Y.XmlElement) return node.toArray().every(isBlank);
  return true;
}

const CONTENT = ['paragraph', 'heading', 'bulletListItem', 'numberedListItem', 'checkListItem'];

/** A list of sibling nodes as blocks, numbering runs of numbered items from 1. */
function blocks(nodes: Node[]): ReactNode[] {
  const out: ReactNode[] = [];
  let number = 0;
  nodes.forEach((node, index) => {
    if (!(node instanceof Y.XmlElement)) {
      if (node instanceof Y.XmlText) out.push(<p key={index}>{runs(node)}</p>);
      return;
    }
    const kind = node.nodeName;
    if (kind === 'blockGroup') {
      out.push(<div key={index} className="space-y-1">{blocks(node.toArray() as Node[])}</div>);
    } else if (kind === 'blockContainer') {
      const children = node.toArray() as Node[];
      const content = children.find((c) => c instanceof Y.XmlElement && CONTENT.includes(c.nodeName)) as Y.XmlElement | undefined;
      if (content?.nodeName === 'numberedListItem') number = Number(content.getAttribute('start') ?? number + 1) || number + 1;
      else number = 0;
      const nested = children.filter((c) => c !== content);
      out.push(
        <div key={index}>
          {content && block(content, number)}
          {nested.length > 0 && <div className="ml-5 mt-1 space-y-1">{blocks(nested)}</div>}
        </div>,
      );
    } else if (CONTENT.includes(kind)) {
      number = kind === 'numberedListItem' ? number + 1 : 0;
      out.push(<div key={index}>{block(node, number)}</div>);
    } else {
      out.push(<div key={index}>{blocks(node.toArray() as Node[])}</div>);
    }
  });
  return out;
}

function block(node: Y.XmlElement, number: number): ReactNode {
  const text = runs(node);
  switch (node.nodeName) {
    case 'heading': {
      const level = Number(node.getAttribute('level') ?? 1);
      return <p className={cx('font-semibold', level === 1 ? 'text-lg' : level === 2 ? 'text-base' : 'text-sm')}>{text}</p>;
    }
    case 'bulletListItem':
      return (
        <p className="flex gap-2">
          <span aria-hidden>&bull;</span>
          <span className="min-w-0">{text}</span>
        </p>
      );
    case 'numberedListItem':
      return (
        <p className="flex gap-2">
          <span aria-hidden className="tabular-nums">{number}.</span>
          <span className="min-w-0">{text}</span>
        </p>
      );
    case 'checkListItem': {
      const checked = String(node.getAttribute('checked')) === 'true';
      return (
        <p className="flex gap-2">
          <span aria-hidden>{checked ? '☑' : '☐'}</span>
          <span className={cx('min-w-0', checked && 'line-through opacity-70')}>{text}</span>
        </p>
      );
    }
    default:
      // An empty paragraph keeps its height, as it does in the editor.
      return <p className="whitespace-pre-wrap">{text.length > 0 ? text : ' '}</p>;
  }
}

/** The text runs under a node, with their formatting. */
function runs(node: Y.XmlElement | Y.XmlText): ReactNode[] {
  if (node instanceof Y.XmlText) return textRuns(node);
  return (node.toArray() as Node[]).flatMap((child) =>
    child instanceof Y.XmlText ? textRuns(child) : child instanceof Y.XmlElement ? runs(child) : [],
  );
}

type Marks = Record<string, unknown> | undefined;

function textRuns(text: Y.XmlText): ReactNode[] {
  return (text.toDelta() as { insert?: unknown; attributes?: Marks }[]).flatMap((op, index) => {
    if (typeof op.insert !== 'string') return [];
    const marks = op.attributes ?? {};
    let content: ReactNode = op.insert;
    if (marks.code) content = <code className="rounded bg-[var(--color-surface)] px-1 font-mono text-[0.9em]">{content}</code>;
    if (marks.bold) content = <strong>{content}</strong>;
    if (marks.italic) content = <em>{content}</em>;
    if (marks.underline) content = <u>{content}</u>;
    if (marks.strike) content = <s>{content}</s>;
    const link = marks.link as { href?: unknown } | undefined;
    // Only web and mail links are drawn as links; notes are other people's text.
    if (link && typeof link.href === 'string' && /^(https?:|mailto:)/i.test(link.href)) {
      content = (
        <a href={link.href} target="_blank" rel="noreferrer" className="text-[var(--color-accent)] underline">
          {content}
        </a>
      );
    }
    return [<span key={index} className="whitespace-pre-wrap">{content}</span>];
  });
}
