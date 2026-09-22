import type { DocumentBlockEditor } from '../components/documentSchema';

/**
 * Getting a Markdown, HTML or Word file into a document.
 *
 * The file is read before the document exists, so a file that will not open
 * never leaves an empty document behind. Its contents then wait here until the
 * new document's editor opens and claims them, the same handoff an imported
 * spreadsheet uses (see sheetImport.ts). They are written through the editor,
 * which is the only thing that knows how to turn them into its blocks.
 */

export interface ImportedDocument {
  title: string;
  fileName: string;
  /** Markdown goes through the editor's Markdown reader; everything else is HTML by then. */
  format: 'markdown' | 'html';
  body: string;
}

/** What the file picker offers. */
export const DOCUMENT_IMPORT_ACCEPT = [
  '.md',
  '.markdown',
  '.html',
  '.htm',
  '.docx',
  'text/markdown',
  'text/html',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
].join(',');

export async function readDocumentFile(file: File): Promise<ImportedDocument> {
  const extension = /\.([^.]+)$/.exec(file.name)?.[1].toLowerCase() ?? '';
  const fallbackTitle = file.name.replace(/\.[^.]+$/, '').trim() || 'Imported document';

  if (extension === 'md' || extension === 'markdown' || file.type === 'text/markdown') {
    const { title, body } = markdownTitle(await file.text());
    return { title: title ?? fallbackTitle, fileName: file.name, format: 'markdown', body };
  }

  if (extension === 'html' || extension === 'htm' || file.type === 'text/html') {
    const { title, body } = htmlTitle(await file.text());
    return { title: title ?? fallbackTitle, fileName: file.name, format: 'html', body };
  }

  if (extension === 'docx') {
    const mammoth = await import('mammoth');
    let html: string;
    try {
      const result = await mammoth.convertToHtml(
        { arrayBuffer: await file.arrayBuffer() },
        {
          // Word's own title styles, so the title can become the document's name.
          styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh"],
        },
      );
      html = result.value;
    } catch {
      throw new Error(`${file.name} could not be read as a Word document.`);
    }
    const { title, body } = htmlTitle(html);
    return { title: title ?? fallbackTitle, fileName: file.name, format: 'html', body };
  }

  throw new Error(`${file.name} is not a Markdown, HTML or Word (.docx) file.`);
}

/**
 * A leading `# Heading` is the document's name, not its first line, so it
 * becomes the title and leaves the body. Front matter is dropped, and its
 * `title:` used when there is one.
 */
function markdownTitle(markdown: string): { title: string | null; body: string } {
  let body = markdown.replace(/^﻿/, '');
  let title: string | null = null;

  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
  if (front) {
    body = body.slice(front[0].length);
    const named = /^title:\s*(.+)$/m.exec(front[1])?.[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (named) title = named;
  }

  const heading = /^\s*#\s+(.+?)\s*#*\s*(?:\r?\n|$)/.exec(body);
  if (heading) {
    title ??= heading[1];
    body = body.slice(heading[0].length);
  }
  return { title, body };
}

/** The same for HTML: a leading <h1>, or failing that the page's <title>. */
function htmlTitle(html: string): { title: string | null; body: string } {
  // Parsed into a document of its own, which never runs scripts or loads images.
  const page = new DOMParser().parseFromString(html, 'text/html');
  let title: string | null = null;

  const first = page.body.firstElementChild;
  if (first?.tagName === 'H1' && first.textContent?.trim()) {
    title = first.textContent.trim();
    first.remove();
  }
  title ??= page.title.trim() || null;
  return { title, body: page.body.innerHTML };
}

// --- handoff ------------------------------------------------------------------

const pending = new Map<string, ImportedDocument>();

export function rememberDocumentImport(documentId: string, imported: ImportedDocument): void {
  pending.set(documentId, imported);
}

/** The file waiting for this document, once; null when there is none. */
export function claimDocumentImport(documentId: string): ImportedDocument | null {
  const imported = pending.get(documentId) ?? null;
  pending.delete(documentId);
  return imported;
}

// --- writing it in ---------------------------------------------------------------

type Blocks = DocumentBlockEditor['document'];

export interface AppliedImport {
  blocks: number;
  /** Images and files that pointed somewhere this server cannot reach, or failed to upload. */
  missingMedia: number;
}

const MEDIA_BLOCKS = new Set(['image', 'video', 'audio', 'file']);

/**
 * Replaces the document's contents with the imported file's.
 *
 * Whatever came from the file is checked on the way in: links keep only web,
 * mail and in-app addresses, and pictures embedded in the file are uploaded to
 * the workspace like any other, rather than kept inline in the document.
 * Pictures that pointed at files beside the original (`images/a.png`) cannot
 * be found from here, and are left as empty blocks to add them to.
 */
export async function applyDocumentImport(
  editor: DocumentBlockEditor,
  imported: ImportedDocument,
  upload: (file: File) => Promise<string>,
): Promise<AppliedImport> {
  const blocks =
    imported.format === 'markdown'
      ? editor.tryParseMarkdownToBlocks(imported.body)
      : editor.tryParseHTMLToBlocks(imported.body);

  let missingMedia = 0;
  const uploads: Promise<void>[] = [];

  const visit = (list: Blocks) => {
    for (const block of list) {
      const props = block.props as Record<string, unknown>;
      if (MEDIA_BLOCKS.has(block.type) && typeof props.url === 'string' && props.url) {
        const url = props.url;
        if (url.startsWith('data:')) {
          uploads.push(
            upload(dataUrlToFile(url, `${block.type}-${uploads.length + 1}`))
              .then((stored) => {
                props.url = stored;
              })
              .catch(() => {
                props.url = '';
                missingMedia++;
              }),
          );
        } else if (!isWebUrl(url)) {
          props.url = '';
          missingMedia++;
        }
      }
      cleanContent(block.content);
      visit(block.children as Blocks);
    }
  };
  visit(blocks);
  await Promise.all(uploads);

  editor.replaceBlocks(editor.document, blocks.length > 0 ? blocks : [{ type: 'paragraph' }]);
  return { blocks: blocks.length, missingMedia };
}

/** Inline content, including a table's cells; links to anything unsafe become their text. */
function cleanContent(content: unknown): void {
  if (!content || typeof content !== 'object') return;
  if (Array.isArray(content)) {
    for (let i = 0; i < content.length; i++) {
      const item = content[i] as { type?: string; href?: string; content?: unknown };
      if (item?.type === 'link' && typeof item.href === 'string' && !isSafeHref(item.href)) {
        content.splice(i, 1, ...((item.content as unknown[]) ?? []));
        i--;
        continue;
      }
      if (item && typeof item === 'object' && 'content' in item) cleanContent(item.content);
    }
    return;
  }
  const table = content as { type?: string; rows?: { cells: unknown[] }[] };
  if (table.type === 'tableContent') {
    for (const row of table.rows ?? []) {
      for (const cell of row.cells) {
        cleanContent(cell && typeof cell === 'object' && 'content' in cell ? (cell as { content: unknown }).content : cell);
      }
    }
  }
}

function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) || url.startsWith('/uploads/');
}

function isSafeHref(href: string): boolean {
  if (/^(https?:|mailto:|tel:)/i.test(href)) return true;
  // In-page anchors and in-app routes; a scheme of any other kind is refused.
  return href.startsWith('#') || (href.startsWith('/') && !href.startsWith('//'));
}

function dataUrlToFile(url: string, name: string): File {
  const comma = url.indexOf(',');
  const header = url.slice(5, comma);
  const type = header.split(';')[0] || 'application/octet-stream';
  const data = url.slice(comma + 1);
  let bytes: Uint8Array<ArrayBuffer>;
  if (header.includes(';base64')) {
    const binary = atob(data);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } else {
    bytes = new Uint8Array(new TextEncoder().encode(decodeURIComponent(data)));
  }
  const extension = type.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
  return new File([bytes], `${name}.${extension}`, { type });
}
