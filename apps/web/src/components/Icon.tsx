import type glyphs from 'bootstrap-icons/font/bootstrap-icons.json';
import { cx } from '../lib/util';

/** Every name Bootstrap Icons ships, so a typo fails the typecheck rather than rendering blank. */
export type IconName = keyof typeof glyphs;

/**
 * A Bootstrap Icons glyph. It is decorative: whatever control holds it carries
 * the accessible label.
 */
export default function Icon({ name, className }: { name: IconName; className?: string }) {
  return <i aria-hidden className={cx('bi', `bi-${name}`, className)} />;
}

/**
 * A document's own icon when it has one — that is user content, typically an
 * emoji — and otherwise a glyph for what kind of document it is.
 */
export function DocumentIcon({
  doc,
  className,
}: {
  doc: { icon?: string | null; isJournal?: boolean; mode?: string };
  className?: string;
}) {
  if (doc.icon) return <span className={className}>{doc.icon}</span>;
  return (
    <Icon
      name={doc.isJournal ? 'journal-text' : doc.mode === 'canvas' ? 'easel' : 'file-earmark-text'}
      className={className}
    />
  );
}
