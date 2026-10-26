import { z } from 'zod';
import type { MessageReferences } from './chat.js';
import type { NotificationWorkspace, User } from './types.js';

/**
 * Comments on the slides of a presentation.
 *
 * A comment is anchored to a slide by its id, and optionally to one element on
 * it. The slides themselves live in the Y.Doc, so the comment keeps the id
 * only: when the slide is deleted the comment stays, and the reader marks it as
 * being on a removed slide by noticing that no such slide is in the deck any more.
 *
 * Comment bodies are written the way chat messages are, so `<@uuid>` tokens
 * name people and follow a rename.
 */

export interface SlideComment {
  id: string;
  presentationId: string;
  slideId: string;
  elementId: string | null;
  parentId: string | null;
  body: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
  author: Pick<User, 'id' | 'name' | 'email' | 'avatarUrl'>;
  replies?: SlideComment[];
}

/** A presentation's comment threads, with what their bodies refer to. */
export interface SlideCommentThreads {
  comments: SlideComment[];
  references: MessageReferences;
}

export const createSlideCommentSchema = z.object({
  body: z.string().trim().min(1).max(10_000),
  slideId: z.string().min(1).max(120),
  elementId: z.string().min(1).max(120).nullish(),
  parentId: z.string().uuid().nullish(),
});

export const updateSlideCommentSchema = z.object({
  body: z.string().trim().min(1).max(10_000).optional(),
  resolved: z.boolean().optional(),
});

export type CreateSlideCommentInput = z.infer<typeof createSlideCommentSchema>;

/** Someone wrote your name in a comment on a slide. Opening it goes to that slide. */
export interface SlideMentionNotification {
  presentationId: string;
  slideId: string;
  title: string;
  workspace: NotificationWorkspace;
  taggedBy: { id: string; name: string; avatarUrl: string | null } | null;
  createdAt: string;
}

/** Where a slide mention opens: the deck, on the slide. */
export function slideMentionPath(workspaceId: string, presentationId: string, slideId: string): string {
  return `/w/${workspaceId}/sl/${presentationId}?slide=${encodeURIComponent(slideId)}`;
}
