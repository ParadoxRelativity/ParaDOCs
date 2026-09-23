import { BlockNoteSchema, createCodeBlockSpec, defaultBlockSpecs, defaultInlineContentSpecs } from '@blocknote/core';
import { codeBlockOptions } from '@blocknote/code-block';
import { createReactBlockSpec, createReactInlineContentSpec } from '@blocknote/react';
import { CALLOUT_BLOCK, SHEET_CELL_INLINE, SHEET_CHART_BLOCK, WORK_ITEM_INLINE } from '@paradocs/shared';
import { SheetCellChip, SheetChartCard, SheetChartTable } from './sheet/SheetRefViews';
import { WorkItemInlineChip } from './projects/WorkItemRefs';
import { CalloutView } from './CalloutBlock';

/**
 * The document editor's schema: BlockNote's own blocks, plus callouts and
 * references to spreadsheet cells and charts, and to work items. The server
 * registers the same types under the same names
 * (apps/api/src/collab/documentSchema.ts) so that saving a document keeps them.
 *
 * A cell draws its value as plain text, and BlockNote builds copied text from
 * what a node draws, so copying a sentence with a cell in it copies the value
 * the reader is looking at.
 */

const sheetCell = createReactInlineContentSpec(SHEET_CELL_INLINE, {
  render: ({ inlineContent }) => <SheetCellChip {...inlineContent.props} />,
});

const sheetChart = createReactBlockSpec(SHEET_CHART_BLOCK, {
  render: ({ block }) => <SheetChartCard {...block.props} />,
  toExternalHTML: ({ block }) => <SheetChartTable {...block.props} />,
});

// A work item reads as its key and title, with its status as it is now.
const workItem = createReactInlineContentSpec(WORK_ITEM_INLINE, {
  render: ({ inlineContent }) => <WorkItemInlineChip {...inlineContent.props} />,
  toExternalHTML: ({ inlineContent }) => <span>{inlineContent.props.label}</span>,
});

// A callout copies and exports as a quote opening with GitHub's alert marker,
// which markdown renders as a callout and anything else still reads as a quote.
const callout = createReactBlockSpec(CALLOUT_BLOCK, {
  render: ({ block, editor, contentRef }) => (
    <CalloutView
      variant={block.props.variant}
      editable={editor.isEditable}
      onVariant={(variant) => editor.updateBlock(block, { props: { variant } })}
      contentRef={contentRef}
    />
  ),
  toExternalHTML: ({ block, contentRef }) => (
    <blockquote>
      <p>[!{block.props.variant.toUpperCase()}]</p>
      <p ref={contentRef} />
    </blockquote>
  ),
});

export const documentSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    // The languages syntax highlighting knows; the highlighter itself is an
    // editor extension, added where the editor is created.
    codeBlock: createCodeBlockSpec(codeBlockOptions),
    sheetChart: sheetChart(),
    callout: callout(),
  },
  inlineContentSpecs: { ...defaultInlineContentSpecs, sheetCell, workItem },
});

export type DocumentBlockEditor = typeof documentSchema.BlockNoteEditor;
