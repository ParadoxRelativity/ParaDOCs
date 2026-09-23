import {
  BlockNoteSchema,
  createBlockSpec,
  createInlineContentSpec,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
} from '@blocknote/core';
import { CALLOUT_BLOCK, SHEET_CELL_INLINE, SHEET_CHART_BLOCK, WORK_ITEM_INLINE, sheetRefUrl } from '@paradocs/shared';

/**
 * The document schema as the server reads it.
 *
 * The server rebuilds every document's blocks and markdown from its Y.Doc when
 * it saves. It has to know every node type the browser's editor can write, or
 * a spreadsheet reference would be dropped from the stored blocks — and from
 * search and export — the first time the document saved.
 *
 * Here a reference is drawn as a link to its placeholder address, so the
 * markdown derived from a document carries it in a form that the export can
 * find and replace with the spreadsheet's current value.
 */

// The API is not compiled against the DOM's types; the server editor supplies a
// document while it renders.
interface Element {
  setAttribute(name: string, value: string): void;
  appendChild(child: Element): void;
  textContent: string | null;
}
const dom = () => (globalThis as unknown as { document: { createElement(tag: string): Element } }).document;

function placeholderLink(url: string, label: string): Element {
  const anchor = dom().createElement('a');
  anchor.setAttribute('href', url);
  anchor.textContent = label;
  return anchor;
}

const sheetCell = createInlineContentSpec(SHEET_CELL_INLINE, {
  render: (inline) => {
    const { spreadsheetId, sheetId, cell, label } = inline.props;
    return { dom: placeholderLink(sheetRefUrl({ kind: 'cell', spreadsheetId, sheetId, cell }), label || cell) as never };
  },
});

const sheetChart = createBlockSpec(SHEET_CHART_BLOCK, {
  render: (block) => {
    const { spreadsheetId, sheetId, chartId, label } = block.props;
    const paragraph = dom().createElement('p');
    paragraph.appendChild(placeholderLink(sheetRefUrl({ kind: 'chart', spreadsheetId, sheetId, chartId }), label || 'Chart'));
    return { dom: paragraph as never };
  },
});

// A work item reads as its key and title, which is what search and an export
// should find. Its status is not written down: that changes without the
// document being saved, and a stale one would be worse than none.
const workItem = createInlineContentSpec(WORK_ITEM_INLINE, {
  render: (inline) => {
    const span = dom().createElement('span');
    span.textContent = inline.props.label || 'Work item';
    return { dom: span as never };
  },
});

// A callout is written as a quote opening with GitHub's alert marker, which
// the markdown derived from it keeps as `> [!WARNING]`.
const callout = createBlockSpec(CALLOUT_BLOCK, {
  render: (block) => {
    const quote = dom().createElement('blockquote');
    const marker = dom().createElement('p');
    marker.textContent = `[!${block.props.variant.toUpperCase()}]`;
    const content = dom().createElement('p');
    quote.appendChild(marker);
    quote.appendChild(content);
    return { dom: quote as never, contentDOM: content as never };
  },
});

export const documentSchema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, sheetChart: sheetChart(), callout: callout() },
  inlineContentSpecs: { ...defaultInlineContentSpecs, sheetCell, workItem },
});
