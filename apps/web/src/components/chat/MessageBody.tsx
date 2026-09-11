import { parseMessage, type MessageReferences } from '@paradocs/shared';
import { emojiOnly } from '../../lib/emoji';
import { cx } from '../../lib/util';
import { DocumentIcon } from '../Icon';

/**
 * Renders a message body, turning `<doc:…>` and `<#…>` tokens into links.
 *
 * References are resolved from the page's reference table rather than baked
 * into the text, so renaming a document updates every message that mentions it.
 * A token that does not resolve — a document since deleted, or one in another
 * workspace — renders as muted text rather than a dead link.
 */
export function MessageBody({
  body,
  references,
  selfId,
  onOpenDocument,
  onOpenChannel,
}: {
  body: string;
  references: MessageReferences;
  /** Whose mentions should stand out. */
  selfId: string;
  onOpenDocument: (id: string) => void;
  onOpenChannel: (id: string) => void;
}) {
  const documents = new Map(references.documents.map((d) => [d.id, d]));
  const channels = new Map(references.channels.map((c) => [c.id, c]));
  const members = new Map(references.members.map((m) => [m.id, m]));
  // A message that is just a few emoji is shown large.
  const emojiCount = emojiOnly(body);
  const jumbo = emojiCount > 0 && emojiCount <= 6;

  return (
    <span className={cx('whitespace-pre-wrap break-words', jumbo && 'text-4xl leading-tight')}>
      {parseMessage(body).map((segment, index) => {
        if (segment.type === 'text') return <span key={index}>{segment.value}</span>;

        if (segment.type === 'document') {
          const doc = documents.get(segment.id);
          if (!doc) return <UnknownRef key={index} label="unknown document" />;
          return (
            <Chip key={index} onClick={() => onOpenDocument(doc.id)}>
              <DocumentIcon doc={doc} /> {doc.title || 'Untitled'}
            </Chip>
          );
        }

        if (segment.type === 'channel') {
          const channel = channels.get(segment.id);
          if (!channel) return <UnknownRef key={index} label="unknown channel" />;
          return (
            <Chip key={index} onClick={() => onOpenChannel(channel.id)}>
              #{channel.name}
            </Chip>
          );
        }

        const member = members.get(segment.id);
        if (!member) return <UnknownRef key={index} label="unknown person" />;
        // Being mentioned yourself is the thing you scan for, so it is painted
        // differently from a mention of someone else.
        const isSelf = member.id === selfId;
        return (
          <span
            key={index}
            title={member.email}
            className={cx(
              'mx-0.5 inline-block rounded px-1.5 py-0.5 align-baseline text-[13px] font-medium',
              isSelf
                ? 'bg-amber-400/25 text-amber-700 dark:text-amber-300'
                : 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]',
            )}
          >
            @{member.name}
          </span>
        );
      })}
    </span>
  );
}

function Chip({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'mx-0.5 inline-flex items-baseline gap-1 rounded px-1.5 py-0.5 align-baseline text-[13px] font-medium',
        'bg-[var(--color-accent)]/15 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25',
      )}
    >
      {children}
    </button>
  );
}

function UnknownRef({ label }: { label: string }) {
  return <span className="mx-0.5 rounded bg-[var(--color-line)] px-1.5 py-0.5 text-[13px] text-[var(--color-muted)]">{label}</span>;
}
