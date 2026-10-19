// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';
import { ySyncPlugin } from 'y-prosemirror';
import { readParagraphs, writeParagraphs } from '@paradocs/shared';
import { richTextSchema } from '../../web/src/components/slides/richTextModel.js';
import {
  backspaceInList,
  formatState,
  numberingPlugin,
  setMark,
  setParagraph,
  shiftLevel,
  splitParagraph,
  toggleList,
  toggleSimpleMark,
} from '../../web/src/components/slides/richTextCommands.js';

/** The slide editor's commands, driven without a browser against a real Y.XmlFragment, as two collaborators would see it. */
function open(fragment: Y.XmlFragment) {
  const state = EditorState.create({
    schema: richTextSchema,
    plugins: [ySyncPlugin(fragment), numberingPlugin(), keymap({ Enter: splitParagraph, Backspace: backspaceInList }), keymap(baseKeymap)],
  });
  return new EditorView(document.createElement('div'), { state });
}

const select = (view: EditorView, from: number, to = from) => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));

describe('rich text editing', () => {
  it('formats a selection and the result is what a collaborator and the read-only view read', () => {
    const doc = new Y.Doc();
    const body = doc.getXmlFragment('body');
    writeParagraphs(body, [{ runs: [{ text: 'Hello world' }] }]);
    const view = open(body);

    select(view, 1, 6);
    toggleSimpleMark(view, 'bold');
    setMark(view, 'color', { color: '#ff0000' });
    setMark(view, 'fontSize', { size: 64 });
    setParagraph(view, { align: 'center' });

    expect(readParagraphs(body)).toEqual([
      {
        align: 'center',
        runs: [
          { text: 'Hello', marks: { bold: true, color: '#ff0000', fontSize: 64 } },
          { text: ' world' },
        ],
      },
    ]);
    expect(formatState(view.state)).toMatchObject({ bold: true, color: '#ff0000', fontSize: 64, align: 'center' });

    // The same edit arrives on another client.
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    expect(readParagraphs(other.getXmlFragment('body'))[0].runs[0].marks?.bold).toBe(true);

    toggleSimpleMark(view, 'bold');
    expect(readParagraphs(body)[0].runs[0].marks?.bold).toBeUndefined();
    view.destroy();
  });

  it('keeps a list going on Enter, ends it on Enter in an empty item, and indents and numbers items', () => {
    const doc = new Y.Doc();
    const body = doc.getXmlFragment('body');
    writeParagraphs(body, [{ runs: [{ text: 'one' }] }]);
    const view = open(body);

    select(view, 4);
    toggleList(view, 'number');
    splitParagraph(view.state, view.dispatch);
    view.dispatch(view.state.tr.insertText('two'));
    splitParagraph(view.state, view.dispatch);
    shiftLevel(view, 1);
    view.dispatch(view.state.tr.insertText('nested'));

    expect(readParagraphs(body).map((p) => [p.bullet, p.level ?? 0, p.runs.map((r) => r.text).join('')])).toEqual([
      ['number', 0, 'one'],
      ['number', 0, 'two'],
      ['number', 1, 'nested'],
    ]);

    // Enter on the empty item ends the list; Backspace at the start of an item steps out.
    splitParagraph(view.state, view.dispatch);
    splitParagraph(view.state, view.dispatch);
    expect(readParagraphs(body).at(-1)).toEqual({ runs: [] });
    view.destroy();
  });

  it('shows bold in the paragraph typed after a bold one', () => {
    const doc = new Y.Doc();
    const body = doc.getXmlFragment('body');
    writeParagraphs(body, [{ runs: [{ text: 'Title', marks: { bold: true } }] }]);
    const view = open(body);
    select(view, 6);
    splitParagraph(view.state, view.dispatch);
    view.dispatch(view.state.tr.insertText('Next'));
    expect(readParagraphs(body)[1].runs).toEqual([{ text: 'Next', marks: { bold: true } }]);
    view.destroy();
  });
});
