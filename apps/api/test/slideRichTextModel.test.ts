import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import { readParagraphs, writeParagraphs, type RichParagraph } from '@paradocs/shared';
import { richTextSchema } from '../../web/src/components/slides/richTextModel.js';

/**
 * The slide editor (ProseMirror, in the web app) and everything else that reads
 * a rich text body (shared/slideRichText.ts) must agree on the Y.XmlFragment's
 * shape. The web app has no test runner of its own; this exercises the editor's
 * schema against the shared reader and writer, without a browser.
 */
describe('rich text editor schema and the shared body format', () => {
  const paragraphs: RichParagraph[] = [
    { align: 'center', runs: [{ text: 'Big ', marks: { fontSize: 64, bold: true } }, { text: 'red', marks: { color: '#ff0000', italic: true, underline: true, strike: true } }] },
    { bullet: 'number', level: 2, runs: [{ text: 'item ' }, { mention: { userId: '11111111-1111-4111-8111-111111111111', label: 'Ada' } }, { text: ' see ' }, { text: 'link', marks: { link: 'https://example.com', highlight: '#fde68a', fontFamily: 'Carlito' } }] },
    { runs: [] },
  ];

  it('loads everything the shared writer writes, and writes it back the same', () => {
    const body = new Y.Doc().getXmlFragment('a');
    writeParagraphs(body, paragraphs);

    const node = yXmlFragmentToProseMirrorRootNode(body, richTextSchema);
    expect(node.childCount).toBe(3);
    expect(node.child(0).attrs.align).toBe('center');
    expect(node.child(1).attrs).toMatchObject({ bullet: 'number', level: '2' });
    expect(node.child(0).child(0).marks.map((m) => m.type.name).sort()).toEqual(['bold', 'fontSize']);
    expect(node.child(0).child(0).marks.find((m) => m.type.name === 'fontSize')!.attrs.size).toBe(64);

    const again = new Y.Doc().getXmlFragment('b');
    prosemirrorToYXmlFragment(node, again);
    expect(readParagraphs(again)).toEqual(paragraphs);
  });
});
