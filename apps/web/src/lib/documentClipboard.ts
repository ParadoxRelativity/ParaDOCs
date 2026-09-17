import type { Fragment } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { chartMarkdownTable } from '@paradocs/shared';
import { cachedSheetRef, sheetCellText } from './sheetRefs';

/**
 * Copying and cutting from a document.
 *
 * BlockNote's own copy handler calls a private export of prosemirror-view that
 * the installed version no longer has. It throws after cancelling the
 * browser's copy, so the clipboard is left empty. This handler runs first and
 * does the job itself:
 *
 * - the rich form goes through ProseMirror's public clipboard serializer, so
 *   pasting back into a document keeps its blocks;
 * - the plain text writes every spreadsheet reference as the value the reader
 *   is looking at — a cell as its value, a chart as a table of its numbers.
 */
export function copyEditorSelection(view: EditorView | undefined, event: ClipboardEvent, cut: boolean): void {
  const data = event.clipboardData;
  // Before the editor has mounted there is no view, and nothing to copy.
  if (!view || !data || view.state.selection.empty) return;
  if (!(event.target instanceof Node) || !view.dom.contains(event.target)) return;

  const slice = view.state.selection.content();
  const { dom } = view.serializeForClipboard(slice);

  // Stopped here, in the capture phase, BlockNote's handler never sees it.
  event.preventDefault();
  event.stopPropagation();
  data.clearData();
  data.setData('blocknote/html', dom.innerHTML);
  data.setData('text/html', dom.innerHTML);
  data.setData('text/plain', plainText(slice.content));

  if (cut && view.editable) view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
}

type RefAttrs = { spreadsheetId: string; sheetId: string; label: string };

function plainText(fragment: Fragment): string {
  const blocks: string[] = [];
  let line = '';
  const endLine = () => {
    if (line) blocks.push(line);
    line = '';
  };

  fragment.descendants((node) => {
    if (node.isText) {
      line += node.text ?? '';
      return false;
    }
    switch (node.type.name) {
      case 'sheetCell': {
        const { spreadsheetId, sheetId, label, cell } = node.attrs as RefAttrs & { cell: string };
        line += sheetCellText({ kind: 'cell', spreadsheetId, sheetId, cell }, label);
        return false;
      }
      case 'sheetChart': {
        const { spreadsheetId, sheetId, label, chartId } = node.attrs as RefAttrs & { chartId: string };
        const result = cachedSheetRef({ kind: 'chart', spreadsheetId, sheetId, chartId });
        endLine();
        blocks.push(
          result?.status === 'ok' && result.kind === 'chart'
            ? chartMarkdownTable(result.title || label, result.data)
            : `${label || 'Chart'} (unavailable)`,
        );
        return false;
      }
      case 'workItem':
        // Its key and title, as they were when it was linked.
        line += (node.attrs as { label: string }).label || 'Work item';
        return false;
      case 'hardBreak':
        line += '\n';
        return false;
    }
    // Each block of text starts a new paragraph of the copied text.
    if (node.isTextblock) endLine();
    return true;
  });
  endLine();
  return blocks.join('\n\n');
}
