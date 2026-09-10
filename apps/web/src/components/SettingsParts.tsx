import { useRef, type ReactNode } from 'react';
import Icon from './Icon';
import { Button } from './ui';

export const FIELD =
  'w-full rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1.5 text-sm ' +
  'outline-none focus:border-[var(--color-accent)] disabled:opacity-60';

export function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {hint && <p className="mb-2 mt-0.5 text-xs text-[var(--color-muted)]">{hint}</p>}
      <div className={hint ? '' : 'mt-2'}>{children}</div>
    </section>
  );
}

/**
 * A picture preview with buttons to upload or remove it. Someone without the
 * right to change the picture sees the preview alone.
 */
export function PictureField({
  preview,
  hasPicture,
  pending,
  disabled = false,
  onPick,
  onRemove,
}: {
  preview: ReactNode;
  hasPicture: boolean;
  pending: boolean;
  disabled?: boolean;
  onPick: (file: File) => void;
  onRemove: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);

  return (
    <div className="flex items-center gap-3">
      {preview}
      {!disabled && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Cleared so choosing the same file again still fires a change.
              e.target.value = '';
              if (file) onPick(file);
            }}
          />
          <Button
            variant="subtle"
            type="button"
            className="text-xs"
            disabled={pending}
            onClick={() => input.current?.click()}
          >
            <Icon name="upload" /> {pending ? 'Saving…' : hasPicture ? 'Change picture' : 'Upload picture'}
          </Button>
          {hasPicture && (
            <Button variant="ghost" type="button" className="text-xs" disabled={pending} onClick={onRemove}>
              Remove
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
