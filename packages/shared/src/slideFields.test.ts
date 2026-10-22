import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  FIELD_NODE,
  createSlide,
  deckSearchText,
  fieldFromAttributes,
  fieldKey,
  paragraphFields,
  readParagraphs,
  readSlide,
  setSlideElement,
  workItemFieldText,
  workItemPercent,
  writeParagraphs,
  type RichParagraph,
  type RichTextElement,
  type WorkItemDetail,
} from './index.js';

const SHEET = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const DOC = '44444444-4444-4444-8444-444444444444';

const paragraphs: RichParagraph[] = [
  {
    runs: [
      { text: 'Revenue is ' },
      { field: { ref: { kind: 'cell', spreadsheetId: SHEET, sheetId: 's1', cell: 'B5' }, label: '$1.2M' } },
      { text: ', and ' },
      { field: { ref: { kind: 'workItem', itemId: ITEM, part: 'percent' }, label: '60%' } },
      { text: ' of ' },
      { field: { ref: { kind: 'document', documentId: DOC }, label: 'The plan' } },
      { text: ' is done.' },
    ],
  },
];

const item = (extra: Partial<WorkItemDetail> = {}): WorkItemDetail => ({
  id: ITEM,
  projectId: '55555555-5555-4555-8555-555555555555',
  key: 'PARA-7',
  title: 'Ship it',
  statusName: 'In progress',
  statusCategory: 'active',
  statusColor: '#2563eb',
  typeName: 'Epic',
  epic: true,
  dueDate: '2026-11-30',
  people: ['Ada', 'Bob'],
  progress: { total: 5, done: 3, estimate: 0, doneEstimate: 0 },
  children: [],
  statuses: [],
  ...extra,
});

describe('live fields in slide text', () => {
  it('round-trip through a text box body, a reload included', () => {
    const doc = new Y.Doc();
    const slide = createSlide(doc);
    setSlideElement(doc, slide, { id: 'a', type: 'richText', x: 0, y: 0, width: 400, height: 200, z: 1, paragraphs });
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    const [element] = readSlide(copy, slide).elements as RichTextElement[];
    expect(element.paragraphs).toEqual(paragraphs);
    expect(paragraphFields(element.paragraphs!).map(fieldKey)).toEqual([`cell:${SHEET}:s1:B5`, `workItem:${ITEM}:percent`, `document:${DOC}`]);
  });

  it('read as what they said when placed, for search', () => {
    const doc = new Y.Doc();
    const slide = createSlide(doc);
    setSlideElement(doc, slide, { id: 'a', type: 'richText', x: 0, y: 0, width: 400, height: 200, z: 1, paragraphs });
    const read = readSlide(doc, slide);
    expect((read.elements[0] as RichTextElement).text).toBe('Revenue is $1.2M, and 60% of The plan is done.');
    expect(deckSearchText([read])).toContain('$1.2M');
  });

  it('drops a field whose node is malformed rather than guess at it', () => {
    const fragment = new Y.Doc().getXmlFragment('body');
    writeParagraphs(fragment, [{ runs: [{ text: 'x' }] }]);
    const paragraph = fragment.get(0) as Y.XmlElement;
    const bad = new Y.XmlElement(FIELD_NODE);
    bad.setAttribute('kind', 'cell');
    bad.setAttribute('target', 'not-an-id');
    paragraph.insert(1, [bad]);
    expect(readParagraphs(fragment)[0].runs).toEqual([{ text: 'x' }]);
    expect(fieldFromAttributes({ kind: 'cell', target: SHEET, sheet: 's1', cell: 'b5; drop' })).toBeNull();
    expect(fieldFromAttributes({ kind: 'workItem', target: ITEM, part: 'nonsense' })).toEqual({ kind: 'workItem', itemId: ITEM, part: 'status' });
  });
});

describe('work item field text', () => {
  it('reads each part of an item as it is now', () => {
    expect(workItemFieldText('key', item())).toBe('PARA-7');
    expect(workItemFieldText('status', item())).toBe('In progress');
    expect(workItemFieldText('people', item())).toBe('Ada, Bob');
    expect(workItemFieldText('people', item({ people: [] }))).toBe('Unassigned');
    expect(workItemFieldText('due', item(), 'en-US')).toBe('Nov 30, 2026');
    expect(workItemFieldText('due', item({ dueDate: null }))).toBe('No due date');
    expect(workItemFieldText('percent', item())).toBe('60%');
    expect(workItemFieldText('count', item())).toBe('3 of 5');
  });

  it('measures an item with nothing under it by its own status', () => {
    expect(workItemPercent(item({ progress: null }))).toBe(0);
    expect(workItemPercent(item({ progress: null, statusCategory: 'done' }))).toBe(100);
    expect(workItemFieldText('count', item({ progress: null, statusCategory: 'done' }))).toBe('1 of 1');
  });
});
