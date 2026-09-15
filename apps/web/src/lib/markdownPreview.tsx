import type { ReactNode } from 'react';
import Icon from '../components/Icon';

/**
 * A small read-only markdown renderer for document previews on the canvas.
 *
 * Mounting a real editor for every card would mean one BlockNote instance per
 * card; previews only need to be legible, so they render as plain DOM. The live
 * editor is mounted only for the card actually being edited.
 */
export function renderMarkdownPreview(markdown: string): ReactNode {
  const lines = markdown.split('\n');
  const blocks: ReactNode[] = [];
  let list: ReactNode[] = [];
  let inCode = false;
  let code: string[] = [];

  const flushList = () => {
    if (list.length === 0) return;
    blocks.push(
      <ul key={`l${blocks.length}`} className="my-1 list-disc space-y-0.5 pl-4">
        {list}
      </ul>,
    );
    list = [];
  };

  lines.forEach((raw, index) => {
    const line = raw.trimEnd();

    if (line.startsWith('```')) {
      if (inCode) {
        blocks.push(
          <pre
            key={`c${index}`}
            className="my-1 overflow-hidden rounded bg-[var(--color-surface)] p-1.5 text-[10px]"
          >
            {code.join('\n')}
          </pre>,
        );
        code = [];
      }
      inCode = !inCode;
      return;
    }
    if (inCode) {
      code.push(raw);
      return;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      const level = heading[1].length;
      blocks.push(
        <p
          key={index}
          className="mt-1.5 font-semibold leading-tight"
          style={{ fontSize: level <= 1 ? '1.05em' : level === 2 ? '1em' : '0.95em' }}
        >
          {inline(heading[2])}
        </p>,
      );
      return;
    }

    const task = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (task) {
      list.push(
        <li key={index} className="list-none -ml-4">
          <Icon name={task[1].trim() ? 'check-square' : 'square'} className="mr-1" />
          {inline(task[2])}
        </li>,
      );
      return;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      list.push(<li key={index}>{inline(bullet[1])}</li>);
      return;
    }

    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (numbered) {
      list.push(<li key={index}>{inline(numbered[1])}</li>);
      return;
    }

    flushList();
    // A captioned image or video is written as an HTML figure; show its caption
    // the way a link label is shown, rather than the markup.
    if (line.startsWith('<figure')) {
      const caption = /<figcaption>(.*?)<\/figcaption>/.exec(line)?.[1];
      if (caption) blocks.push(<p key={index} className="my-1 leading-snug text-[var(--color-accent)]">{caption}</p>);
      return;
    }
    if (line.trim()) blocks.push(<p key={index} className="my-1 leading-snug">{inline(line)}</p>);
  });

  flushList();
  return blocks;
}

/** Handles bold, italic and inline code within a line. */
function inline(text: string): ReactNode {
  const parts: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]*\))/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${match.index}`;
    if (token.startsWith('**')) parts.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('`')) {
      parts.push(
        <code key={key} className="rounded bg-[var(--color-surface)] px-1 text-[0.9em]">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('[')) {
      parts.push(<span key={key} className="text-[var(--color-accent)]">{/\[([^\]]+)\]/.exec(token)?.[1]}</span>);
    } else parts.push(<em key={key}>{token.slice(1, -1)}</em>);
    last = match.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
