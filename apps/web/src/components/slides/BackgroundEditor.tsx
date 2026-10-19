import { useRef } from 'react';
import { THEME_COLOR_SLOTS, resolveSlideColor, themeColor, type SlideBackground, type Theme, type ThemeColorSlot } from '@paradocs/shared';
import { uploadSlideFile } from '../../lib/slideUploads';
import { cx } from '../../lib/util';
import { Button } from '../ui';
import type { SlideEditorContext } from './slideExtensions';
import { ColorInput, Field, NumberInput, SelectInput } from './inspectorParts';
import { backgroundStyle } from './SlideView';

/** Uploads a picture for this deck and returns the address a slide stores. */
export const uploadPicture = (ctx: Pick<SlideEditorContext, 'workspaceId' | 'presentationId'>) => async (file: File) =>
  (await uploadSlideFile(ctx.workspaceId, ctx.presentationId, file)).url;

export const SLOT_LABELS: Record<ThemeColorSlot, string> = {
  dark1: 'Dark 1',
  light1: 'Light 1',
  dark2: 'Dark 2',
  light2: 'Light 2',
  accent1: 'Accent 1',
  accent2: 'Accent 2',
  accent3: 'Accent 3',
  accent4: 'Accent 4',
  accent5: 'Accent 5',
  accent6: 'Accent 6',
  hyperlink: 'Link',
  followedHyperlink: 'Followed link',
};

/**
 * One color field that can be a fixed color or a theme slot: the swatches are
 * the theme's own, so choosing one binds the color to the theme and a theme
 * change restyles it; the picker chooses a fixed color a theme change leaves
 * alone.
 */
export function ThemeColorPicker({
  value,
  theme,
  label,
  disabled,
  onChange,
}: {
  value: string | undefined;
  theme: Theme;
  label: string;
  disabled?: boolean;
  onChange: (color: string) => void;
}) {
  const current = resolveSlideColor(value, theme) ?? '#000000';
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={label}>
      {THEME_COLOR_SLOTS.filter((slot) => slot !== 'followedHyperlink').map((slot) => {
        const selected = value === themeColor(slot);
        return (
          <button
            key={slot}
            type="button"
            title={SLOT_LABELS[slot]}
            aria-label={`${label}: ${SLOT_LABELS[slot]}`}
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onChange(themeColor(slot))}
            className={cx(
              // A touch target on phones: 28px square, padded by the gap.
              'h-7 w-7 rounded border border-[var(--color-line)] sm:h-5 sm:w-5',
              selected && 'outline outline-2 outline-offset-1 outline-[var(--color-accent)]',
            )}
            style={{ background: theme.colors[slot] }}
          />
        );
      })}
      <ColorInput label={`${label}: custom color`} value={current} fallback={current} disabled={disabled} onChange={onChange} />
    </div>
  );
}

type Kind = 'inherit' | 'color' | 'gradient' | 'image';

/**
 * Edits a slide, layout or master background: solid (a theme slot or any
 * color), gradient or picture. `null` means "take the one behind" and is
 * offered only where there is one.
 */
export default function BackgroundEditor({
  value,
  theme,
  disabled,
  inheritLabel,
  onChange,
  upload,
}: {
  value: SlideBackground | null | undefined;
  theme: Theme;
  disabled?: boolean;
  /** What null means here ("Same as layout"); leave out where the background is required. */
  inheritLabel?: string;
  onChange: (background: SlideBackground | null) => void;
  upload?: (file: File) => Promise<string>;
}) {
  const file = useRef<HTMLInputElement>(null);
  const kind: Kind = value?.kind ?? 'inherit';
  const options: { value: Kind; label: string }[] = [
    ...(inheritLabel ? [{ value: 'inherit' as const, label: inheritLabel }] : []),
    { value: 'color', label: 'Solid color' },
    { value: 'gradient', label: 'Gradient' },
    ...(upload ? [{ value: 'image' as const, label: 'Picture' }] : []),
  ];

  const choose = (next: Kind | '') => {
    if (next === 'inherit') onChange(null);
    else if (next === 'color') onChange({ kind: 'color', color: themeColor('background1') });
    else if (next === 'gradient') {
      onChange({ kind: 'gradient', angle: 180, stops: [{ offset: 0, color: themeColor('accent1', 40) }, { offset: 1, color: themeColor('accent1') }] });
    } else if (next === 'image') file.current?.click();
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="h-7 w-12 shrink-0 rounded border border-[var(--color-line)]"
          style={value ? backgroundStyle(value, theme) : undefined}
        />
        <SelectInput<Kind> label="Background type" value={kind} disabled={disabled} options={options} onChange={choose} className="flex-1" />
      </div>
      {value?.kind === 'color' && <ThemeColorPicker label="Background color" value={value.color} theme={theme} disabled={disabled} onChange={(color) => onChange({ kind: 'color', color })} />}
      {value?.kind === 'gradient' && (
        <div className="space-y-1.5">
          {value.stops.map((stop, i) => (
            <div key={i} className="space-y-1">
              <span className="text-xs text-[var(--color-muted)]">{i === 0 ? 'From' : i === value.stops.length - 1 ? 'To' : `Stop ${i + 1}`}</span>
              <ThemeColorPicker
                label={`Gradient stop ${i + 1}`}
                value={stop.color}
                theme={theme}
                disabled={disabled}
                onChange={(color) => onChange({ ...value, stops: value.stops.map((s, n) => (n === i ? { ...s, color } : s)) })}
              />
            </div>
          ))}
          <Field label="Angle">
            <NumberInput label="Gradient angle (degrees)" value={value.angle} min={-360} max={360} disabled={disabled || value.radial} onCommit={(angle) => onChange({ ...value, angle })} />
          </Field>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={value.radial === true} disabled={disabled} onChange={(e) => onChange({ ...value, radial: e.target.checked || undefined })} />
            Radial
          </label>
        </div>
      )}
      {value?.kind === 'image' && upload && (
        <Button variant="subtle" className="!px-2 !py-1 text-xs" disabled={disabled} onClick={() => file.current?.click()}>
          Replace picture
        </Button>
      )}
      <input
        ref={file}
        type="file"
        accept="image/*"
        hidden
        onChange={async (e) => {
          const picked = e.target.files?.[0];
          e.target.value = '';
          if (!picked || !upload) return;
          try {
            onChange({ kind: 'image', url: await upload(picked) });
          } catch (err) {
            window.alert(err instanceof Error ? err.message : 'Could not upload that picture.');
          }
        }}
      />
    </div>
  );
}
