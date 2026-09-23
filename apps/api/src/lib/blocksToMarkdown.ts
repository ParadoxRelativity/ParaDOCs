/**
 * Server-side BlockNote -> markdown.
 *
 * The web client renders markdown with BlockNote's own exporter and sends it as
 * `bodyMd`. This is the fallback for API clients that only send `body`, so that
 * search and export still work for documents this server never saw a browser for.
 * It is intentionally lossy in the same way BlockNote's exporter is.
 */

interface StyledText {
  type?: string;
  text?: string;
  href?: string;
  styles?: Record<string, unknown>;
  content?: StyledText[] | string;
}

interface Block {
  id?: string;
  type?: string;
  props?: Record<string, unknown>;
  content?: StyledText[] | string;
  children?: Block[];
}

function renderInline(content: StyledText[] | string | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  // A table's content is an object of rows rather than inline content; the
  // table case renders its cells itself.
  if (!Array.isArray(content)) return '';
  return content
    .map((node) => {
      if (node.type === 'link') {
        const label = renderInline(node.content);
        return `[${label}](${node.href ?? ''})`;
      }
      let text = node.text ?? renderInline(node.content);
      const styles = node.styles ?? {};
      // Innermost markers first so nesting reads correctly.
      if (styles.code) text = `\`${text}\``;
      if (styles.bold) text = `**${text}**`;
      if (styles.italic) text = `*${text}*`;
      if (styles.strike) text = `~~${text}~~`;
      if (styles.underline) text = `<u>${text}</u>`;
      return text;
    })
    .join('');
}

function renderBlock(block: Block, depth: number): string[] {
  const indent = '  '.repeat(depth);
  const props = block.props ?? {};
  const text = renderInline(block.content);
  const lines: string[] = [];

  switch (block.type) {
    case 'heading': {
      const level = Math.min(Math.max(Number(props.level ?? 1), 1), 6);
      lines.push(`${'#'.repeat(level)} ${text}`);
      break;
    }
    case 'bulletListItem':
      lines.push(`${indent}- ${text}`);
      break;
    case 'numberedListItem':
      lines.push(`${indent}1. ${text}`);
      break;
    case 'checkListItem':
      lines.push(`${indent}- [${props.checked ? 'x' : ' '}] ${text}`);
      break;
    case 'codeBlock':
      lines.push(`\`\`\`${props.language ?? ''}`, text, '```');
      break;
    case 'callout':
      // GitHub's alert syntax, which is also what the editor exports. The blank
      // lines keep it from running into a quote or callout beside it.
      lines.push('', `> [!${String(props.variant ?? 'note').toUpperCase()}]`, `> ${text}`, '');
      break;
    case 'image': {
      const caption = String(props.caption ?? '');
      lines.push(`![${caption}](${String(props.url ?? '')})`);
      break;
    }
    case 'video':
    case 'audio':
    case 'file': {
      // No markdown for these, so they become links and stay searchable.
      const label = String(props.caption || props.name || block.type);
      lines.push(`[${label}](${String(props.url ?? '')})`);
      break;
    }
    case 'table': {
      // A cell is its inline content, or, as the editor now saves it, a
      // tableCell object holding that content.
      type Cell = StyledText[] | string | { content?: StyledText[] | string };
      const rows = (block.content as unknown as { rows?: { cells: Cell[] }[] } | undefined)?.rows ?? [];
      rows.forEach((row, index) => {
        const cells = row.cells.map((cell) =>
          renderInline(Array.isArray(cell) || typeof cell === 'string' ? cell : cell?.content).replace(/\|/g, '\\|'),
        );
        lines.push(`| ${cells.join(' | ')} |`);
        if (index === 0) lines.push(`| ${cells.map(() => '---').join(' | ')} |`);
      });
      break;
    }
    default:
      // paragraph and anything we do not special-case
      lines.push(text ? `${indent}${text}` : '');
  }

  for (const child of block.children ?? []) {
    lines.push(...renderBlock(child, depth + 1));
  }
  return lines;
}

export function blocksToMarkdown(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  const lines: string[] = [];
  for (const block of blocks as Block[]) {
    lines.push(...renderBlock(block, 0));
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** First non-empty line of a document, used to auto-name untitled documents. */
export function deriveTitle(markdown: string, fallback = 'Untitled'): string {
  const line = markdown
    .split('\n')
    .map((l) => l.replace(/^#{1,6}\s*/, '').replace(/^[-*]\s+(\[[ x]\]\s*)?/, '').trim())
    .find((l) => l.length > 0);
  if (!line) return fallback;
  return line.slice(0, 120);
}
