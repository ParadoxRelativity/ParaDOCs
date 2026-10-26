import { useState } from 'react';
import {
  FONT_SIZES,
  MAX_LIST_LEVEL,
  SLIDE_FONTS,
  resolveSlideColor,
  textColumns,
  type RichAlign,
  type RichTextElement,
  type RichTextVerticalAlign,
} from '@paradocs/shared';
import { Button } from '../ui';
import { setMark, setParagraph, shiftLevel, toggleList, toggleSimpleMark, type FormatState } from './richTextCommands';
import { useActiveEditor } from './richTextSession';
import { ColorInput, Field, Group, NumberInput, SelectInput, ToolButton } from './inspectorParts';
import { registerSlideInspectorSection, type SlideEditorContext } from './slideExtensions';

const DEFAULT_SIZE = 32;

/** What the controls show when no editor is open: the first box's first run, and whether all its text is bold, and so on. */
function snapshotFormat(element: RichTextElement): FormatState {
  const paragraphs = element.paragraphs ?? [];
  const runs = paragraphs.flatMap((p) => p.runs.filter((r) => r.text));
  const all = (key: 'bold' | 'italic' | 'underline' | 'strike') => runs.length > 0 && runs.every((r) => r.marks?.[key]);
  const first = runs[0]?.marks;
  const p = paragraphs[0];
  return {
    bold: all('bold'),
    italic: all('italic'),
    underline: all('underline'),
    strike: all('strike'),
    color: first?.color,
    highlight: first?.highlight,
    fontSize: first?.fontSize ?? element.fontSize ?? DEFAULT_SIZE,
    fontFamily: first?.fontFamily ?? element.fontFamily,
    link: first?.link,
    align: p?.align ?? element.align,
    bullet: p?.bullet,
    level: p?.level ?? 0,
  };
}

const ALIGN: { value: RichAlign; label: string; icon: 'text-left' | 'text-center' | 'text-right' | 'justify' }[] = [
  { value: 'left', label: 'Align left', icon: 'text-left' },
  { value: 'center', label: 'Align center', icon: 'text-center' },
  { value: 'right', label: 'Align right', icon: 'text-right' },
  { value: 'justify', label: 'Justify', icon: 'justify' },
];

/**
 * Text formatting for the selected rich text boxes. While the box is being
 * edited the controls act on the selection (or on what is typed next); with
 * the box merely selected they act on all its text. Either way the same
 * attributes are written, so what shows afterwards is the same.
 */
function RichTextInspector({ ctx }: { ctx: SlideEditorContext }) {
  const { slide, selection, actions, theme, canEdit } = ctx;
  const boxes = selection.filter((el): el is RichTextElement => el.type === 'richText');
  const active = useActiveEditor();
  const single = boxes.length === 1 ? boxes[0] : null;
  const live = active && single && active.elementId === single.id ? active : null;
  const [link, setLink] = useState('');
  if (!slide || boxes.length === 0) return null;

  const base = snapshotFormat(boxes[0]);
  // What the cursor sits in has no size or font of its own when the box's default applies.
  const format: FormatState = live ? { ...live.format, fontSize: live.format.fontSize ?? base.fontSize, fontFamily: live.format.fontFamily ?? base.fontFamily } : base;
  const disabled = !canEdit;
  const ids = boxes.map((b) => b.id);
  const patch = (changes: Record<string, unknown>) => actions.updateElements(slide.id, ids.map((id) => ({ id, patch: changes })));

  const toggle = (name: 'bold' | 'italic' | 'underline' | 'strike') => {
    if (live) toggleSimpleMark(live.view, name);
    else actions.formatText(slide.id, ids, { marks: { [name]: format[name] ? null : {} } });
  };
  const mark = (name: string, attrs: Record<string, unknown> | null) => {
    if (live) setMark(live.view, name, attrs);
    else actions.formatText(slide.id, ids, { marks: { [name]: attrs } });
  };
  const paragraph = (changes: Record<string, string | number | null>) => {
    if (live) setParagraph(live.view, changes);
    else actions.formatText(slide.id, ids, { paragraph: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v === null ? null : String(v)])) });
  };
  const list = (kind: 'bullet' | 'number') => {
    if (live) return toggleList(live.view, kind);
    const on = format.bullet === kind;
    actions.formatText(slide.id, ids, { paragraph: on ? { bullet: null, level: null } : { bullet: kind } });
  };
  const indent = (delta: number) => {
    if (live) return shiftLevel(live.view, delta);
    const level = Math.min(Math.max(format.level + delta, 0), MAX_LIST_LEVEL);
    actions.formatText(slide.id, ids, { paragraph: { level: level ? String(level) : null } });
  };

  const family = format.fontFamily ?? '';
  const textColor = format.color ?? boxes[0].color;
  return (
    <div className="space-y-4 text-sm">
      <Group title="Text">
        {canEdit && !live && single && (
          <Button variant="subtle" className="w-full !py-1 text-xs" onClick={() => ctx.edit(single.id)}>
            Edit text (Enter)
          </Button>
        )}
        <div className="flex items-center gap-1">
          <SelectInput
            label="Font"
            value={family}
            disabled={disabled}
            className="min-w-0 flex-1"
            options={[{ value: '', label: 'Theme font' }, ...SLIDE_FONTS.map((f) => ({ value: f.family, label: f.family }))]}
            onChange={(value) => {
              if (live) setMark(live.view, 'fontFamily', value ? { family: value } : null);
              else {
                actions.formatText(slide.id, ids, { marks: { fontFamily: value ? { family: value } : null } });
                patch({ fontFamily: value || undefined });
              }
            }}
          />
          <NumberInput
            label="Font size"
            value={format.fontSize}
            min={6}
            max={600}
            list="slide-font-sizes"
            disabled={disabled}
            onCommit={(size) => {
              mark('fontSize', { size });
              if (!live) patch({ fontSize: size });
            }}
          />
          <datalist id="slide-font-sizes">
            {FONT_SIZES.map((size) => (
              <option key={size} value={size} />
            ))}
          </datalist>
        </div>
        <div className="flex flex-wrap items-center gap-0.5">
          <ToolButton label="Bold (Ctrl+B)" icon="type-bold" active={format.bold} disabled={disabled} onClick={() => toggle('bold')} />
          <ToolButton label="Italic (Ctrl+I)" icon="type-italic" active={format.italic} disabled={disabled} onClick={() => toggle('italic')} />
          <ToolButton label="Underline (Ctrl+U)" icon="type-underline" active={format.underline} disabled={disabled} onClick={() => toggle('underline')} />
          <ToolButton label="Strikethrough" icon="type-strikethrough" active={format.strike} disabled={disabled} onClick={() => toggle('strike')} />
          <ColorInput label="Text color" value={resolveSlideColor(textColor, theme)} fallback="#111827" disabled={disabled} onChange={(color) => mark('color', { color })} />
          <ColorInput label="Highlight color" value={format.highlight} fallback="#fde68a" disabled={disabled} onChange={(color) => mark('highlight', { color })} />
          {format.highlight && <ToolButton label="Remove highlight" icon="x-lg" disabled={disabled} onClick={() => mark('highlight', null)} />}
        </div>
      </Group>

      <Group title="Paragraph">
        <div className="flex flex-wrap items-center gap-0.5">
          {ALIGN.map((a) => (
            <ToolButton key={a.value} label={a.label} icon={a.icon} active={(format.align ?? 'left') === a.value} disabled={disabled} onClick={() => paragraph({ align: a.value === 'left' ? null : a.value })} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-0.5">
          <ToolButton label="Bulleted list" icon="list-ul" active={format.bullet === 'bullet'} disabled={disabled} onClick={() => list('bullet')} />
          <ToolButton label="Numbered list" icon="list-ol" active={format.bullet === 'number'} disabled={disabled} onClick={() => list('number')} />
          <ToolButton label="Decrease indent (Shift+Tab)" icon="text-indent-right" disabled={disabled || !format.bullet} onClick={() => indent(-1)} />
          <ToolButton label="Increase indent (Tab)" icon="text-indent-left" disabled={disabled || !format.bullet} onClick={() => indent(1)} />
        </div>
        <Field label="Line spacing">
          <SelectInput
            label="Line spacing"
            value={String(boxes[0].lineSpacing ?? 1.2)}
            disabled={disabled}
            options={['1', '1.2', '1.5', '2'].map((v) => ({ value: v, label: v }))}
            onChange={(value) => patch({ lineSpacing: Number(value) })}
          />
        </Field>
        <Field label="Vertical">
          <SelectInput<RichTextVerticalAlign>
            label="Vertical alignment"
            value={boxes[0].verticalAlign ?? 'top'}
            disabled={disabled}
            options={[
              { value: 'top', label: 'Top' },
              { value: 'middle', label: 'Middle' },
              { value: 'bottom', label: 'Bottom' },
            ]}
            onChange={(value) => patch({ verticalAlign: value === 'top' ? undefined : value })}
          />
        </Field>
        <Field label="Columns">
          <SelectInput
            label="Columns"
            value={String(textColumns(boxes[0]))}
            disabled={disabled}
            options={['1', '2', '3', '4'].map((v) => ({ value: v, label: v }))}
            // Written outright, so a box can undo what its placeholder sets.
            onChange={(value) => patch({ columns: Number(value) })}
          />
        </Field>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={boxes[0].autofit !== false} disabled={disabled} onChange={(e) => patch({ autofit: e.target.checked ? undefined : false })} />
          <span>Shrink text on overflow</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={boxes[0].wrap !== false} disabled={disabled} onChange={(e) => patch({ wrap: e.target.checked })} />
          <span>Wrap text in box</span>
        </label>
      </Group>

      <Group title="Link">
        <div className="flex items-center gap-1">
          <input
            aria-label="Link address"
            placeholder={live ? 'https://' : 'Edit the text to add a link'}
            value={link || format.link || ''}
            disabled={disabled || !live}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            className="min-w-0 flex-1 rounded border border-[var(--color-line)] bg-[var(--color-canvas)] px-1.5 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
          />
          <Button
            variant="subtle"
            className="!px-2 !py-1 text-xs"
            disabled={disabled || !live}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const href = (link || format.link || '').trim();
              if (live) setMark(live.view, 'link', href ? { href: /^[a-z]+:/i.test(href) ? href : `https://${href}` } : null);
              setLink('');
            }}
          >
            {format.link && !link ? 'Remove' : 'Apply'}
          </Button>
        </div>
      </Group>
    </div>
  );
}

registerSlideInspectorSection({
  id: 'rich-text',
  order: 10,
  applies: (ctx, scope) => scope === 'elements' && ctx.selection.some((el) => el.type === 'richText'),
  render: (ctx) => <RichTextInspector ctx={ctx} />,
});
