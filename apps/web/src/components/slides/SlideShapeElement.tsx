import { memo } from 'react';
import {
  SLIDE_SHAPE_KINDS,
  SLIDE_SHAPE_LABELS,
  dashArray,
  resolveSlideColor,
  shapeGeometry,
  shapeTextInset,
  type SlideShapeElement,
  type SlideShapeKind,
  type Theme,
} from '@paradocs/shared';
import { EditableText } from '../canvas/CanvasElementView';
import { Field, Group, NumberInput, SelectInput } from './inspectorParts';
import { registerSlideElementRenderer, registerSlideInspectorSection, type SlideElementRendererProps } from './slideExtensions';

const DEFAULT_TEXT_SIZE = 40;

/** Light text on a dark fill and dark on a light one, so text typed into a shape reads whatever it is filled with. */
function readableOn(fill: string | undefined, theme: Theme): string {
  const hex = fill?.replace('#', '');
  if (!hex || hex.length !== 6) return theme.colors.dark1;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? theme.colors.dark1 : theme.colors.light1;
}

/**
 * A shape: one SVG path in the element's box (so it scales without distorting
 * its outline), optionally filled, outlined and shadowed, with text inside
 * sized for a slide rather than for a board.
 */
const ShapeRenderer = memo(function ShapeRenderer({ element, theme, selected, editing, readOnly, members, onUpdate, onStopEditing }: SlideElementRendererProps) {
  const shape = element as SlideShapeElement;
  const width = Math.max(1, shape.width);
  const height = Math.max(1, shape.height);
  const geometry = shapeGeometry(shape.shape, width, height);
  const fill = geometry.open || !shape.fill || shape.fill === 'transparent' ? 'none' : resolveSlideColor(shape.fill, theme);
  const stroke = resolveSlideColor(shape.stroke ?? (geometry.open ? 'theme:accent1' : undefined), theme);
  const strokeWidth = stroke ? (shape.strokeWidth ?? 2) : 0;
  const inset = shapeTextInset(shape.shape);
  const color = resolveSlideColor(shape.color, theme) ?? readableOn(resolveSlideColor(shape.fill, theme), theme);
  const text = shape.text ?? '';

  return (
    <div className="relative h-full w-full" style={{ filter: shape.shadow ? 'drop-shadow(0 8px 12px rgba(0,0,0,.35))' : undefined }}>
      <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden>
        <path
          d={geometry.d}
          fill={fill}
          stroke={stroke ?? 'none'}
          strokeWidth={strokeWidth}
          strokeDasharray={dashArray(shape.dash ?? 'solid', strokeWidth || 2)}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      {!geometry.open && (readOnly ? text.length > 0 : true) && (
        <div
          className="absolute grid place-items-center"
          style={{
            left: `${inset.left * 100}%`,
            top: `${inset.top * 100}%`,
            right: `${inset.right * 100}%`,
            bottom: `${inset.bottom * 100}%`,
            padding: 16,
          }}
        >
          <EditableText
            value={text}
            editing={!readOnly && editing}
            placeholder={!readOnly && selected ? 'Double-click to write' : ''}
            members={members}
            onChange={(next) => onUpdate(shape.id, { text: next })}
            onStopEditing={() => onStopEditing(shape.id)}
            className="w-full resize-none bg-transparent text-center leading-tight outline-none"
            style={{ color, fontSize: shape.fontSize ?? DEFAULT_TEXT_SIZE, fontFamily: `${theme.fonts.body}, ui-sans-serif, system-ui, sans-serif`, ...(editing ? { height: '100%' } : {}) }}
          />
        </div>
      )}
    </div>
  );
});

registerSlideElementRenderer('shape', ShapeRenderer);

function ShapeInspector({ ctx }: { ctx: Parameters<Parameters<typeof registerSlideInspectorSection>[0]['render']>[0] }) {
  const { slide, selection, actions, canEdit } = ctx;
  const shapes = selection.filter((el): el is SlideShapeElement & { id: string } => el.type === 'shape');
  if (!slide || shapes.length === 0) return null;
  const first = shapes[0];
  const patch = (changes: Record<string, unknown>) => actions.updateElements(slide.id, shapes.map((s) => ({ id: s.id, patch: changes })));
  return (
    <Group title="Shape">
      <Field label="Kind">
        <SelectInput<SlideShapeKind>
          label="Shape"
          value={first.shape}
          disabled={!canEdit}
          options={SLIDE_SHAPE_KINDS.map((kind) => ({ value: kind, label: SLIDE_SHAPE_LABELS[kind] }))}
          onChange={(value) => value && patch({ shape: value })}
        />
      </Field>
      <Field label="Outline">
        <NumberInput label="Outline width" value={first.strokeWidth ?? 2} min={0} max={40} disabled={!canEdit} onCommit={(value) => patch({ strokeWidth: value })} />
      </Field>
      <Field label="Text size">
        <NumberInput label="Text size" value={first.fontSize ?? DEFAULT_TEXT_SIZE} min={8} max={400} disabled={!canEdit} onCommit={(value) => patch({ fontSize: value })} />
      </Field>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={first.shadow === true} disabled={!canEdit} onChange={(e) => patch({ shadow: e.target.checked ? true : undefined })} />
        <span>Shadow</span>
      </label>
    </Group>
  );
}

registerSlideInspectorSection({
  id: 'shape',
  order: 20,
  applies: (ctx, scope) => scope === 'elements' && ctx.selection.some((el) => el.type === 'shape'),
  render: (ctx) => <ShapeInspector ctx={ctx} />,
});
