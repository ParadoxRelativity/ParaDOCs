import type { CSSProperties } from 'react';
import { Schema, type DOMOutputSpec, type MarkSpec, type NodeSpec } from 'prosemirror-model';
import { MAX_LIST_LEVEL, RICH_ALIGNMENTS, fontStack, textInsets, type RichMarks, type RichParagraph } from '@paradocs/shared';

/**
 * How rich text looks, written once for the editor (ProseMirror) and the
 * read-only view (React), so what is drawn while typing is what thumbnails and
 * the slideshow draw.
 *
 * Sizes are `calc(Npx * var(--fit, 1))`: a box that shrinks its text to fit
 * sets `--fit` below 1 on itself and every size follows, including each run's
 * own.
 */

export const px = (size: number) => `calc(${size}px * var(--fit, 1))`;

/** A text box's margins as CSS padding. They hold their size when autofit shrinks the text, as in PowerPoint. */
export function insetPadding(box: Parameters<typeof textInsets>[0]): string {
  const inset = textInsets(box);
  return `${inset.top}px ${inset.right}px ${inset.bottom}px ${inset.left}px`;
}

export function markStyle(marks: RichMarks | undefined): CSSProperties {
  if (!marks) return {};
  const style: CSSProperties = {};
  if (marks.bold) style.fontWeight = 700;
  if (marks.italic) style.fontStyle = 'italic';
  const lines = [marks.underline && 'underline', marks.strike && 'line-through'].filter(Boolean);
  if (lines.length) style.textDecorationLine = lines.join(' ');
  if (marks.color) style.color = marks.color;
  if (marks.highlight) style.backgroundColor = marks.highlight;
  if (marks.fontSize) style.fontSize = px(marks.fontSize);
  if (marks.fontFamily) style.fontFamily = fontStack(marks.fontFamily);
  return style;
}

/** Only addresses a slide may safely link to: a script URL in a mark would run for everyone who clicks it. */
export function safeHref(href: string | undefined | null): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, 'https://invalid.example');
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? href : null;
  } catch {
    return null;
  }
}

/** A paragraph's own layout: its alignment and spacing, and room for its list marker. */
export function paragraphStyle(paragraph: Pick<RichParagraph, 'align' | 'bullet' | 'level' | 'lineHeight'>): CSSProperties {
  const level = paragraph.bullet ? Math.min(paragraph.level ?? 0, MAX_LIST_LEVEL) : 0;
  return {
    textAlign: paragraph.align,
    // Without its own, a paragraph takes the box's line spacing from its container.
    lineHeight: paragraph.lineHeight,
    paddingLeft: paragraph.bullet ? `${(level + 1) * 1.1}em` : undefined,
    ['--level' as string]: level,
  };
}

function css(style: CSSProperties): string {
  return Object.entries(style)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key.startsWith('--') ? key : key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${value}`)
    .join(';');
}

const span = (marks: RichMarks): DOMOutputSpec => ['span', { style: css(markStyle(marks)) }, 0];

const nodes: Record<string, NodeSpec> = {
  doc: { content: 'paragraph+' },
  paragraph: {
    content: 'inline*',
    group: 'block',
    attrs: { align: { default: null }, bullet: { default: null }, level: { default: null }, lineHeight: { default: null } },
    parseDOM: [
      { tag: 'p' },
      { tag: 'div' },
      { tag: 'h1,h2,h3,h4,h5,h6' },
      { tag: 'li', getAttrs: () => ({ bullet: 'bullet' }) },
    ],
    toDOM: (node) => {
      const attrs = node.attrs as Record<string, unknown>;
      const bullet = attrs.bullet === 'bullet' || attrs.bullet === 'number' ? (attrs.bullet as string) : undefined;
      const align = RICH_ALIGNMENTS.includes(attrs.align as never) ? (attrs.align as RichParagraph['align']) : undefined;
      const level = Math.max(0, Math.min(Math.round(Number(attrs.level)) || 0, MAX_LIST_LEVEL));
      const lineHeight = Number(attrs.lineHeight) > 0 ? Number(attrs.lineHeight) : undefined;
      return [
        'p',
        {
          class: 'slide-p',
          'data-bullet': bullet,
          style: css(paragraphStyle({ align, bullet: bullet as RichParagraph['bullet'], level, lineHeight })),
        },
        0,
      ];
    },
  },
  mention: {
    inline: true,
    group: 'inline',
    atom: true,
    selectable: true,
    attrs: { userId: { default: '' }, label: { default: '' } },
    toDOM: (node) => ['span', { class: 'slide-mention', 'data-user-id': node.attrs.userId }, `@${node.attrs.label}`],
  },
  // A live value (shared/slideFields.ts). The editor draws it with a node view; this is only what it copies as.
  field: {
    inline: true,
    group: 'inline',
    atom: true,
    selectable: true,
    attrs: { kind: { default: '' }, target: { default: '' }, sheet: { default: '' }, cell: { default: '' }, part: { default: '' }, label: { default: '' } },
    toDOM: (node) => ['span', { class: 'slide-field' }, String(node.attrs.label)],
  },
  text: { group: 'inline' },
};

const marks: Record<string, MarkSpec> = {
  bold: {
    parseDOM: [{ tag: 'strong' }, { tag: 'b' }, { style: 'font-weight', getAttrs: (v) => (/^(bold|[6-9]\d\d)$/.test(v as string) ? null : false) }],
    toDOM: () => span({ bold: true }),
  },
  italic: { parseDOM: [{ tag: 'em' }, { tag: 'i' }, { style: 'font-style=italic' }], toDOM: () => span({ italic: true }) },
  underline: { parseDOM: [{ tag: 'u' }, { style: 'text-decoration-line=underline' }], toDOM: () => span({ underline: true }) },
  strike: { parseDOM: [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }], toDOM: () => span({ strike: true }) },
  color: { attrs: { color: { default: '#000000' } }, toDOM: (mark) => span({ color: mark.attrs.color }) },
  highlight: { attrs: { color: { default: '#fde68a' } }, toDOM: (mark) => span({ highlight: mark.attrs.color }) },
  fontSize: { attrs: { size: { default: 32 } }, toDOM: (mark) => span({ fontSize: Number(mark.attrs.size) || 32 }) },
  fontFamily: { attrs: { family: { default: 'Inter' } }, toDOM: (mark) => span({ fontFamily: mark.attrs.family }) },
  link: {
    attrs: { href: { default: '' } },
    inclusive: false,
    parseDOM: [{ tag: 'a[href]', getAttrs: (dom) => ({ href: (dom as HTMLElement).getAttribute('href') }) }],
    toDOM: (mark) => ['a', { href: safeHref(mark.attrs.href) ?? undefined, class: 'slide-link', target: '_blank', rel: 'noopener noreferrer' }, 0],
  },
};

export const richTextSchema = new Schema({ nodes, marks });
