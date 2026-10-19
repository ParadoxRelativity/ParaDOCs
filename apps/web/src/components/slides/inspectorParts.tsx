import { useEffect, useState, type ReactNode } from 'react';
import { cx } from '../../lib/util';
import Icon, { type IconName } from '../Icon';
import { IconButton } from '../ui';

/** Controls the content sections of the inspector (text, shapes, tables, pictures) are made of. */

export function Group({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">{title}</h3>
      {children}
    </section>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-[var(--color-muted)]">{label}</span>
      {children}
    </label>
  );
}

/** A toggle button. Pressing it must not take focus from a text box being edited, or the edit would end. */
export function ToolButton({
  label,
  icon,
  active,
  disabled,
  onClick,
}: {
  label: string;
  icon: IconName;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <IconButton
      label={label}
      type="button"
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cx(active && '!bg-[var(--color-accent-soft)] !text-[var(--color-accent)]', disabled && 'opacity-40')}
    >
      <Icon name={icon} />
    </IconButton>
  );
}

export function ColorInput({ value, fallback, label, disabled, onChange }: { value?: string; fallback: string; label: string; disabled?: boolean; onChange: (color: string) => void }) {
  const hex = value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  return (
    <input
      type="color"
      aria-label={label}
      title={label}
      value={hex}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="h-6 w-9 cursor-pointer rounded border border-[var(--color-line)] bg-transparent p-0"
    />
  );
}

/** A number applied when committed (Enter or leaving the field), so a half-typed value never reaches collaborators. */
export function NumberInput({
  value,
  label,
  min,
  max,
  step,
  disabled,
  list,
  onCommit,
}: {
  value: number | undefined;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  list?: string;
  onCommit: (value: number) => void;
}) {
  const shown = value === undefined ? '' : String(Math.round(value * 100) / 100);
  const [draft, setDraft] = useState(shown);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(shown);
  }, [shown, focused]);
  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed) || draft.trim() === '') return setDraft(shown);
    const next = Math.min(Math.max(parsed, min ?? -Infinity), max ?? Infinity);
    if (next !== value) onCommit(next);
    setDraft(String(next));
  };
  return (
    <input
      inputMode="decimal"
      aria-label={label}
      list={list}
      step={step}
      value={draft}
      disabled={disabled}
      onFocus={(e) => {
        setFocused(true);
        e.currentTarget.select();
      }}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(shown);
          e.currentTarget.blur();
        }
        e.stopPropagation();
      }}
      className="w-16 rounded border border-[var(--color-line)] bg-[var(--color-canvas)] px-1.5 py-1 text-xs tabular-nums outline-none focus:border-[var(--color-accent)]"
    />
  );
}

export function SelectInput<T extends string>({
  value,
  label,
  options,
  disabled,
  onChange,
  className,
}: {
  value: T | '';
  label: string;
  options: { value: T | ''; label: string }[];
  disabled?: boolean;
  onChange: (value: T | '') => void;
  className?: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T | '')}
      className={cx('min-w-0 rounded border border-[var(--color-line)] bg-[var(--color-canvas)] px-1 py-1 text-xs', className)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
