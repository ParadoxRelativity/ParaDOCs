import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { MessageReferences, SlideComment } from '@paradocs/shared';
import {
  useMarkSlideMentionsRead,
  useMe,
  useNotifications,
  useSlideCommentActions,
  useSlideComments,
  useWorkspaces,
} from '../../api/hooks';
import { useBackHandler } from '../../lib/back';
import { useIsMobile } from '../../lib/mobile';
import { canFrom } from '../../lib/permissions';
import { cx, formatDateTime, formatRelative, useLocalStorage } from '../../lib/util';
import Avatar from '../Avatar';
import Icon from '../Icon';
import { MessageBody } from '../chat/MessageBody';
import ReferenceEditor from '../projects/ReferenceEditor';
import { useToast } from '../Toast';
import { Spinner } from '../ui';
import { registerSlidePanel, type SlideEditorContext } from './slideExtensions';

/**
 * Comment threads on slides, under the stage beside the speaker notes. A thread
 * belongs to the open slide and, optionally, to one element on it. Anyone who
 * can see the deck reads them; writing takes the Slides comment permission.
 *
 * Comments are written the way chat messages are, so `@` offers the workspace's
 * people and a tagged person is notified, with a link that opens the deck on
 * this slide. A comment whose slide has been deleted is kept and listed under
 * "On removed slides" rather than lost.
 *
 * On a phone the open list is a sheet over the editor, closed by Android back.
 */

const EMPTY_REFERENCES: MessageReferences = { documents: [], spreadsheets: [], channels: [], members: [] };

export function SlideCommentsPanel({ ctx }: { ctx: SlideEditorContext }) {
  const { presentationId, workspaceId, slide, slides } = ctx;
  const mobile = useIsMobile();
  const [openPref, setOpen] = useLocalStorage<boolean>('paradocs.slides.comments.open', false);
  const threads = useSlideComments(presentationId);
  const markRead = useMarkSlideMentionsRead();
  const notifications = useNotifications();
  const workspaces = useWorkspaces();
  const can = canFrom(workspaces.data?.find((w) => w.id === workspaceId)?.permissions);
  const canComment = can('slides.comment');

  // Being named in a comment here is answered by opening the deck, and the list is opened for them.
  const named = notifications.data?.slideMentions?.some((m) => m.presentationId === presentationId) ?? false;
  const [shownForMention, setShownForMention] = useState(false);
  useEffect(() => {
    if (!named) return;
    markRead.mutate([presentationId]);
    if (!shownForMention) {
      setShownForMention(true);
      setOpen(true);
    }
    // The mutation object is stable; including it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [named, presentationId]);

  const open = openPref;
  useBackHandler(() => setOpen(false), { active: mobile && open });

  const all = threads.data?.comments ?? [];
  const live = useMemo(() => new Set(slides.map((s) => s.id)), [slides]);
  const here = all.filter((c) => slide && c.slideId === slide.id);
  const removed = all.filter((c) => !live.has(c.slideId));
  const openHere = here.filter((c) => !c.resolved).length;
  const total = openHere + removed.filter((c) => !c.resolved).length;

  if (!slide) return null;

  const body = (
    <div className={cx('flex min-h-0 flex-col', mobile && 'max-h-[70vh]')}>
      <div className={cx('scroll-thin min-h-0 space-y-3 overflow-y-auto px-3 pb-2', !mobile && 'max-h-56')}>
        {threads.isLoading ? (
          <Spinner />
        ) : threads.error ? (
          <p className="text-xs text-red-500">Could not load comments.</p>
        ) : (
          <>
            {here.length === 0 && (
              <p className="text-xs text-[var(--color-muted)]">
                No comments on this slide yet.{canComment ? ' Add one below.' : ''}
              </p>
            )}
            {here.map((comment) => (
              <Thread
                key={comment.id}
                comment={comment}
                ctx={ctx}
                references={threads.data?.references ?? EMPTY_REFERENCES}
                canComment={canComment}
              />
            ))}
            {removed.length > 0 && (
              <div className="space-y-3 border-t border-[var(--color-line)] pt-2">
                <h4 className="text-xs font-semibold text-[var(--color-muted)]">On removed slides</h4>
                {removed.map((comment) => (
                  <Thread
                    key={comment.id}
                    comment={comment}
                    ctx={ctx}
                    references={threads.data?.references ?? EMPTY_REFERENCES}
                    canComment={canComment}
                    removedSlide
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {canComment && <Composer ctx={ctx} />}
    </div>
  );

  return (
    <section aria-label="Slide comments" className="border-t border-[var(--color-line)] bg-[var(--color-canvas)]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-xs font-medium text-[var(--color-muted)] hover:text-[var(--color-ink)]"
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        Comments
        {total > 0 && (
          <span className="rounded-full bg-[var(--color-accent)] px-1.5 text-[10px] font-semibold text-white" title={`${total} open`}>
            {total}
          </span>
        )}
      </button>
      {open &&
        (mobile ? (
          <div className="fixed inset-x-0 bottom-0 z-40 overflow-hidden rounded-t-xl border-t border-[var(--color-line)] bg-[var(--color-canvas)] shadow-2xl">
            <div className="flex items-center justify-between border-b border-[var(--color-line)] px-3 py-1.5">
              <span className="text-sm font-medium">Comments</span>
              <button type="button" aria-label="Close comments" onClick={() => setOpen(false)} className="grid h-7 w-7 place-items-center rounded-md hover:bg-[var(--color-surface)]">
                <Icon name="x-lg" />
              </button>
            </div>
            <div className="pt-2">{body}</div>
          </div>
        ) : (
          body
        ))}
    </section>
  );
}

function Thread({
  comment,
  ctx,
  references,
  canComment,
  removedSlide = false,
}: {
  comment: SlideComment;
  ctx: SlideEditorContext;
  references: MessageReferences;
  canComment: boolean;
  removedSlide?: boolean;
}) {
  const actions = useSlideCommentActions(ctx.presentationId);
  const toast = useToast();
  const [replying, setReplying] = useState(false);
  const replies = comment.replies ?? [];
  const slideOf = ctx.slides.find((s) => s.id === comment.slideId);
  const element = slideOf?.elements.find((e) => e.id === comment.elementId);
  const fail = (err: unknown) => toast(err instanceof Error ? err.message : 'Could not save the comment', 'error');

  return (
    <div className={cx('rounded-md border border-[var(--color-line)] p-2', comment.resolved && 'opacity-60')}>
      <div className="flex flex-wrap items-center gap-1.5 pb-1 text-[11px] text-[var(--color-muted)]">
        {removedSlide && (
          <span className="rounded bg-[var(--color-surface)] px-1.5 py-0.5" title="The slide this was written on has been deleted">
            Removed slide
          </span>
        )}
        {comment.elementId &&
          (element && !removedSlide ? (
            <button
              type="button"
              className="rounded bg-[var(--color-surface)] px-1.5 py-0.5 hover:text-[var(--color-ink)]"
              onClick={() => ctx.select([element.id])}
              title="Select the element this is about"
            >
              <Icon name="cursor" /> On a {element.type === 'richText' ? 'text box' : element.type}
            </button>
          ) : (
            <span className="rounded bg-[var(--color-surface)] px-1.5 py-0.5">On an element that is gone</span>
          ))}
        {comment.resolved && <span>Resolved</span>}
      </div>
      <Entry comment={comment} ctx={ctx} references={references} canComment={canComment} />
      {replies.map((reply) => (
        <div key={reply.id} className="mt-2 border-l-2 border-[var(--color-line)] pl-2">
          <Entry comment={reply} ctx={ctx} references={references} canComment={canComment} />
        </div>
      ))}
      {canComment && (
        <div className="mt-1.5 flex gap-3 text-xs text-[var(--color-muted)]">
          <button type="button" className="hover:text-[var(--color-ink)]" onClick={() => setReplying((r) => !r)}>
            Reply
          </button>
          <button
            type="button"
            className="hover:text-[var(--color-ink)]"
            onClick={() => actions.update.mutate({ id: comment.id, resolved: !comment.resolved }, { onError: fail })}
          >
            {comment.resolved ? 'Reopen' : 'Resolve'}
          </button>
        </div>
      )}
      {replying && (
        <div className="mt-2">
          <ReferenceEditor
            workspaceId={ctx.workspaceId}
            minRows={2}
            autoFocus
            placeholder="Reply…"
            submitLabel="Reply"
            onCancel={() => setReplying(false)}
            onSubmit={async (body) => {
              if (!body) return;
              try {
                await actions.add.mutateAsync({ body, slideId: comment.slideId, parentId: comment.id });
                setReplying(false);
              } catch (err) {
                fail(err);
                throw err;
              }
            }}
          />
        </div>
      )}
    </div>
  );
}

/** One comment: who and when, its text, and edit and delete for its author. */
function Entry({
  comment,
  ctx,
  references,
  canComment,
}: {
  comment: SlideComment;
  ctx: SlideEditorContext;
  references: MessageReferences;
  canComment: boolean;
}) {
  const me = useMe().data?.user;
  const navigate = useNavigate();
  const actions = useSlideCommentActions(ctx.presentationId);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const own = me?.id === comment.author.id;
  const base = `/w/${ctx.workspaceId}`;

  return (
    <div className="group flex gap-2">
      <Avatar name={comment.author.name} url={comment.author.avatarUrl} seed={comment.author.id} size="xs" className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-xs font-semibold">{comment.author.name}</span>
          <span className="text-[10px] text-[var(--color-muted)]" title={formatDateTime(comment.createdAt)}>
            {formatRelative(comment.createdAt)}
            {comment.updatedAt !== comment.createdAt && ' (edited)'}
          </span>
          {own && canComment && !editing && (
            <span className="ml-auto flex gap-2 text-[11px] text-[var(--color-muted)] sm:hidden sm:group-hover:flex sm:group-focus-within:flex">
              <button type="button" className="hover:text-[var(--color-ink)]" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button
                type="button"
                className="hover:text-red-500"
                onClick={() =>
                  actions.remove.mutate(comment.id, {
                    onError: (err) => toast(err instanceof Error ? err.message : 'Could not delete the comment', 'error'),
                  })
                }
              >
                Delete
              </button>
            </span>
          )}
        </div>
        {editing ? (
          <div className="mt-1">
            <ReferenceEditor
              workspaceId={ctx.workspaceId}
              initialBody={comment.body}
              references={references}
              autoFocus
              minRows={2}
              submitLabel="Save"
              onCancel={() => setEditing(false)}
              onSubmit={async (body) => {
                if (!body) return;
                try {
                  await actions.update.mutateAsync({ id: comment.id, body });
                  setEditing(false);
                } catch (err) {
                  toast(err instanceof Error ? err.message : 'Could not save the comment', 'error');
                }
              }}
            />
          </div>
        ) : (
          <div className="text-sm leading-relaxed">
            <MessageBody
              body={comment.body}
              references={references}
              selfId={me?.id ?? ''}
              onOpenDocument={(id) => navigate(`${base}/d/${id}`)}
              onOpenSpreadsheet={(id) => navigate(`${base}/s/${id}`)}
              onOpenChannel={(id) => navigate(`${base}/c/${id}`)}
              onOpenPresentation={(deck, slideId) => navigate(`${base}/sl/${deck.id}${slideId ? `?slide=${encodeURIComponent(slideId)}` : ''}`)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** A new comment on the open slide, on the selected element when there is exactly one and it is left ticked. */
function Composer({ ctx }: { ctx: SlideEditorContext }) {
  const { slide, selection } = ctx;
  const actions = useSlideCommentActions(ctx.presentationId);
  const toast = useToast();
  const [anchored, setAnchored] = useState(true);
  const target = selection.length === 1 ? selection[0] : null;
  // A different selection is a fresh choice.
  useEffect(() => setAnchored(true), [target?.id]);
  if (!slide) return null;

  return (
    <div className="border-t border-[var(--color-line)] px-3 pt-2 pb-2">
      {target && (
        <label className="mb-1 flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
          <input type="checkbox" checked={anchored} onChange={(e) => setAnchored(e.target.checked)} />
          On the selected {target.type === 'richText' ? 'text box' : target.type}
        </label>
      )}
      <ReferenceEditor
        // A fresh box per slide, so a draft never lands on a slide it was not written for.
        key={slide.id}
        workspaceId={ctx.workspaceId}
        minRows={2}
        placeholder="Comment on this slide. @ mentions someone."
        submitLabel="Comment"
        onSubmit={async (body) => {
          if (!body) return;
          try {
            await actions.add.mutateAsync({ body, slideId: slide.id, elementId: target && anchored ? target.id : null });
          } catch (err) {
            toast(err instanceof Error ? err.message : 'Could not add the comment', 'error');
            throw err;
          }
        }}
      />
    </div>
  );
}

registerSlidePanel({ id: 'comments', order: 20, render: (ctx) => <SlideCommentsPanel ctx={ctx} /> });
