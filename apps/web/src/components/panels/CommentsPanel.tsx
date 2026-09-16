import { useState } from 'react';
import type { Comment } from '@paradocs/shared';
import { useComments, useCreateComment, useDeleteComment, useUpdateComment } from '../../api/hooks';
import { cx, formatRelative } from '../../lib/util';
import { Button, Spinner } from '../ui';
import Avatar from '../Avatar';
import Icon from '../Icon';

export default function CommentsPanel({ documentId, currentUserId }: { documentId: string; currentUserId: string }) {
  const comments = useComments(documentId);
  const create = useCreateComment(documentId);
  const [draft, setDraft] = useState('');
  const [showResolved, setShowResolved] = useState(false);

  if (comments.isLoading) return <Spinner />;

  const all = comments.data ?? [];
  const visible = showResolved ? all : all.filter((c) => !c.resolved);
  const resolvedCount = all.filter((c) => c.resolved).length;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    create.mutate({ body: draft.trim() });
    setDraft('');
  }

  return (
    <div className="flex h-full flex-col">
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3">
        {visible.length === 0 && (
          <p className="py-6 text-center text-xs text-[var(--color-muted)]">
            No comments yet.
          </p>
        )}
        <div className="space-y-3">
          {visible.map((comment) => (
            <CommentThread
              key={comment.id}
              comment={comment}
              documentId={documentId}
              currentUserId={currentUserId}
            />
          ))}
        </div>
        {resolvedCount > 0 && (
          <button
            onClick={() => setShowResolved((v) => !v)}
            className="mt-3 w-full text-center text-[11px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
          >
            {showResolved ? 'Hide' : 'Show'} {resolvedCount} resolved
          </button>
        )}
      </div>

      <form onSubmit={submit} className="border-t border-[var(--color-line)] p-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter makes a new line.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit(e);
            }
          }}
          rows={2}
          placeholder="Add a comment…"
          className="w-full resize-none rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        <Button variant="primary" type="submit" className="mt-1.5 w-full text-xs" disabled={!draft.trim()}>
          Comment
        </Button>
      </form>
    </div>
  );
}

function CommentThread({
  comment,
  documentId,
  currentUserId,
}: {
  comment: Comment;
  documentId: string;
  currentUserId: string;
}) {
  const update = useUpdateComment(documentId);
  const remove = useDeleteComment(documentId);
  const create = useCreateComment(documentId);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState('');

  return (
    <div className={cx('rounded-lg border border-[var(--color-line)] p-2.5', comment.resolved && 'opacity-60')}>
      <CommentBody comment={comment} currentUserId={currentUserId} onDelete={() => remove.mutate(comment.id)} />

      {comment.replies?.map((child) => (
        <div key={child.id} className="mt-2 border-l-2 border-[var(--color-line)] pl-2.5">
          <CommentBody comment={child} currentUserId={currentUserId} onDelete={() => remove.mutate(child.id)} />
        </div>
      ))}

      <div className="mt-2 flex gap-2 text-[11px]">
        <button
          onClick={() => setReplying((v) => !v)}
          className="text-[var(--color-muted)] hover:text-[var(--color-ink)]"
        >
          Reply
        </button>
        <button
          onClick={() => update.mutate({ id: comment.id, resolved: !comment.resolved })}
          className="text-[var(--color-muted)] hover:text-[var(--color-ink)]"
        >
          {comment.resolved ? 'Reopen' : 'Resolve'}
        </button>
      </div>

      {replying && (
        <form
          className="mt-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!reply.trim()) return;
            create.mutate({ body: reply.trim(), parentId: comment.id });
            setReply('');
            setReplying(false);
          }}
        >
          <input
            autoFocus
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Reply…"
            className="w-full rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
          />
        </form>
      )}
    </div>
  );
}

function CommentBody({
  comment,
  currentUserId,
  onDelete,
}: {
  comment: Comment;
  currentUserId: string;
  onDelete: () => void;
}) {
  return (
    <div className="group">
      <div className="flex items-baseline gap-1.5">
        <Avatar
          name={comment.author.name}
          url={comment.author.avatarUrl}
          seed={comment.author.id}
          size="xs"
          className="self-center"
        />
        <span className="text-xs font-medium">{comment.author.name}</span>
        <span className="text-[10px] text-[var(--color-muted)]">{formatRelative(comment.createdAt)}</span>
        {comment.author.id === currentUserId && (
          <button
            onClick={onDelete}
            aria-label="Delete comment"
            className="ml-auto hidden text-xs text-[var(--color-muted)] hover:text-red-500 group-hover:block"
          >
            <Icon name="trash3" />
          </button>
        )}
      </div>
      <p className="mt-0.5 whitespace-pre-wrap text-sm">{comment.body}</p>
    </div>
  );
}
