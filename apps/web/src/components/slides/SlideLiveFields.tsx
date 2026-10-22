import { useEffect, useState } from 'react';
import type { EditorView } from 'prosemirror-view';
import {
  WORK_ITEM_FIELD_PARTS,
  fieldAttributes,
  workItemFieldText,
  type RichTextElement,
  type SheetRef,
  type SlideField,
  type WorkItemFieldPart,
} from '@paradocs/shared';
import { useDocument } from '../../api/hooks';
import { cachedSheetRef, useLiveSheetRef } from '../../lib/sheetRefs';
import { useWorkItemDetail } from '../../lib/workItemRefs';
import { cx } from '../../lib/util';
import Icon from '../Icon';
import { Modal } from '../Modal';
import { Button } from '../ui';
import SheetRefPicker from '../sheet/SheetRefPicker';
import { WorkItemPicker } from '../projects/WorkItemRefs';
import { Group } from './inspectorParts';
import { richTextSchema } from './richTextModel';
import { currentEditor } from './richTextSession';
import { DocumentPicker } from './SlideLiveElements';
import { stopShow, useSlideLink, type SlideLinkTarget } from './slideLinks';
import { registerSlideInspectorSection, type SlideEditorContext } from './slideExtensions';

/**
 * Live fields in slide text (the model is in shared/slideFields.ts): how one
 * draws, and how one is put into a text box.
 *
 * A field draws as plain text in the box's own type, so a sentence reads as a
 * sentence; only the editor marks it out. Like a live element it asks for its
 * value as the viewer, and shows a lock, never its label, to someone who may
 * not see the source.
 */

export function fieldSheetRef(field: Extract<SlideField, { kind: 'cell' }>): SheetRef {
  return { kind: 'cell', spreadsheetId: field.spreadsheetId, sheetId: field.sheetId, cell: field.cell };
}

/** What following a field from a show opens. */
export function fieldTarget(field: SlideField): SlideLinkTarget {
  switch (field.kind) {
    case 'cell':
      return { kind: 'sheet', ref: fieldSheetRef(field) };
    case 'workItem':
      return { kind: 'workItem', itemId: field.itemId };
    case 'document':
      return { kind: 'document', documentId: field.documentId };
  }
}

/** A field's value as it is now: text, or null while it loads, or `locked` when this viewer may not see it. */
function useFieldValue(field: SlideField, live: boolean): string | null | 'locked' {
  const cell = useLiveSheetRef(field.kind === 'cell' ? fieldSheetRef(field) : null, live);
  const item = useWorkItemDetail(field.kind === 'workItem' ? field.itemId : null, live);
  const doc = useDocument(field.kind === 'document' ? field.documentId : undefined);
  switch (field.kind) {
    case 'cell':
      if (!cell) return null;
      return cell.status === 'ok' && cell.kind === 'cell' ? cell.display : 'locked';
    case 'workItem':
      if (!item.data) return item.isLoading ? null : 'locked';
      return workItemFieldText(field.part, item.data);
    case 'document':
      if (!doc.data) return doc.isLoading ? null : 'locked';
      return doc.data.title || 'Untitled';
  }
}

/**
 * One field, drawn. `live` keeps it asking while its slide is watched;
 * in a show it opens what it names when clicked.
 */
export function LiveFieldValue({ field, live }: { field: SlideField; live: boolean }) {
  const value = useFieldValue(field, live);
  const open = useSlideLink();
  if (value === 'locked') {
    return (
      <span className="slide-field slide-field-locked" title="Not available: you may not have access to its source">
        <Icon name="lock-fill" />
      </span>
    );
  }
  // Marked while loading, so a PDF export waits for the value (SlidePrintJob).
  if (value === null) return <span className="slide-field" data-live-loading="">…</span>;
  if (!open) return <span className="slide-field">{value}</span>;
  return (
    <span
      role="link"
      className="slide-field slide-field-link"
      style={{ pointerEvents: 'auto' }}
      onPointerDown={stopShow}
      onPointerUp={stopShow}
      onClick={(e) => {
        e.stopPropagation();
        open(fieldTarget(field));
      }}
    >
      {value}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Putting a field in a box
// ---------------------------------------------------------------------------

/** Fields waiting for their box's editor to open: the picker can outlast the edit it was started from. */
const queued = new Map<string, { ref: SlideField; label: string }[]>();

/** Puts a field at the caret of the box being edited, or keeps it for the box's editor when that is not open. */
function insertField(elementId: string, ref: SlideField, label: string): boolean {
  const active = currentEditor();
  if (active?.elementId !== elementId) {
    queued.set(elementId, [...(queued.get(elementId) ?? []), { ref, label }]);
    return false;
  }
  placeField(active.view, ref, label);
  return true;
}

function placeField(view: EditorView, ref: SlideField, label: string) {
  const node = richTextSchema.nodes.field.create({ ...fieldAttributes(ref), label });
  const { from, to } = view.state.selection;
  view.dispatch(view.state.tr.replaceWith(from, to, node).scrollIntoView());
  view.focus();
}

/** For a box's editor once it is open: places whatever fields were chosen for it while it was not. */
export function placeQueuedFields(elementId: string, view: EditorView) {
  const waiting = queued.get(elementId);
  if (!waiting) return;
  queued.delete(elementId);
  for (const { ref, label } of waiting) placeField(view, ref, label);
}

type Step = { kind: 'choose' } | { kind: 'cell' } | { kind: 'workItem' } | { kind: 'part'; itemId: string } | { kind: 'document' };

/** The steps of choosing a field: what kind, which one, and for a work item, what of it. */
function FieldPicker({ workspaceId, onPick, onCancel }: { workspaceId: string; onPick: (ref: SlideField, label: string) => void; onCancel: () => void }) {
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const confirmLabel = 'Insert';
  if (step.kind === 'cell') {
    return (
      <SheetRefPicker
        kind="cell"
        workspaceId={workspaceId}
        confirmLabel={confirmLabel}
        onCancel={onCancel}
        onInsert={(ref) => {
          if (ref.kind !== 'cell') return;
          const known = cachedSheetRef(ref);
          onPick({ kind: 'cell', spreadsheetId: ref.spreadsheetId, sheetId: ref.sheetId, cell: ref.cell }, known?.status === 'ok' && known.kind === 'cell' ? known.display : ref.label);
        }}
      />
    );
  }
  if (step.kind === 'workItem') {
    return <WorkItemPicker workspaceId={workspaceId} confirmLabel="Next" onCancel={onCancel} onPick={(item) => setStep({ kind: 'part', itemId: item.id })} />;
  }
  if (step.kind === 'part') return <PartPicker itemId={step.itemId} onPick={onPick} onCancel={onCancel} />;
  if (step.kind === 'document') {
    return (
      <DocumentPicker
        workspaceId={workspaceId}
        title="Name a document"
        description="Its title is set in the text, and opens the document when clicked in the slideshow."
        confirmLabel={confirmLabel}
        onCancel={onCancel}
        onPick={(doc) => onPick({ kind: 'document', documentId: doc.id }, doc.title)}
      />
    );
  }
  const kinds: { kind: Step['kind']; icon: Parameters<typeof Icon>[0]['name']; label: string; hint: string }[] = [
    { kind: 'cell', icon: 'table', label: 'Spreadsheet cell', hint: 'Its value, as the sheet has it now' },
    { kind: 'workItem', icon: 'kanban', label: 'Work item', hint: 'Its status, assignee, due date, or how much of an epic is done' },
    { kind: 'document', icon: 'file-earmark-text', label: 'Document', hint: 'Its title, opening the document in the slideshow' },
  ];
  return (
    <Modal
      title="Insert a live value"
      description="Set in the text and kept current wherever the slide is shown."
      onClose={onCancel}
      footer={
        <Button variant="subtle" className="text-xs" onClick={onCancel}>
          Cancel
        </Button>
      }
    >
      <ul className="space-y-1">
        {kinds.map((k) => (
          <li key={k.kind}>
            <button
              autoFocus={k.kind === 'cell'}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-[var(--color-surface)] focus:bg-[var(--color-surface)] focus:outline-none"
              onClick={() => setStep({ kind: k.kind } as Step)}
            >
              <Icon name={k.icon} className="text-base text-[var(--color-muted)]" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm">{k.label}</span>
                <span className="block text-xs text-[var(--color-muted)]">{k.hint}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/** What of a work item to show, each with what it reads now. */
function PartPicker({ itemId, onPick, onCancel }: { itemId: string; onPick: (ref: SlideField, label: string) => void; onCancel: () => void }) {
  const item = useWorkItemDetail(itemId).data;
  const [part, setPart] = useState<WorkItemFieldPart>(WORK_ITEM_FIELD_PARTS[0].part);
  // An epic is most often shown by how far along it is.
  useEffect(() => {
    if (item?.progress) setPart('percent');
  }, [item?.progress]);
  const pick = () => item && onPick({ kind: 'workItem', itemId, part }, workItemFieldText(part, item));
  return (
    <Modal
      title={item ? `${item.key} ${item.title}` : 'Work item'}
      description="What of it to show."
      onClose={onCancel}
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" className="text-xs" disabled={!item} onClick={pick}>
            Insert
          </Button>
        </>
      }
    >
      <ul className="space-y-0.5">
        {WORK_ITEM_FIELD_PARTS.map((p) => (
          <li key={p.part}>
            <label className={cx('flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm', part === p.part ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-surface)]')}>
              <input type="radio" name="field-part" checked={part === p.part} onChange={() => setPart(p.part)} onDoubleClick={pick} />
              <span className="flex-1">{p.label}</span>
              <span className="max-w-[50%] truncate text-xs text-[var(--color-muted)]">{item ? workItemFieldText(p.part, item) : '…'}</span>
            </label>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function FieldsInspector({ ctx }: { ctx: SlideEditorContext }) {
  const [picking, setPicking] = useState(false);
  const box = ctx.selection.length === 1 && ctx.selection[0].type === 'richText' ? (ctx.selection[0] as RichTextElement) : null;
  if (!box || !ctx.canEdit) return null;
  return (
    <Group title="Live value">
      <Button
        variant="subtle"
        className="w-full !py-1 text-xs"
        // Keeps the caret where it is in the box being edited.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setPicking(true)}
      >
        <Icon name="lightning-charge" className="mr-1" />
        Insert a live value…
      </Button>
      <p className="mt-1 text-[11px] leading-snug text-[var(--color-muted)]">A cell, a work item’s status or progress, or a document, kept current in the text.</p>
      {picking && (
        <FieldPicker
          workspaceId={ctx.workspaceId}
          onCancel={() => setPicking(false)}
          onPick={(ref, label) => {
            setPicking(false);
            // Picked after the edit ended (Esc in the picker ends it too): the box opens again with the field at its end.
            if (!insertField(box.id, ref, label)) ctx.edit(box.id);
          }}
        />
      )}
    </Group>
  );
}

registerSlideInspectorSection({
  id: 'rich-text-fields',
  order: 11,
  applies: (ctx, scope) => scope === 'elements' && ctx.canEdit && ctx.selection.length === 1 && ctx.selection[0].type === 'richText',
  render: (ctx) => <FieldsInspector ctx={ctx} />,
});
