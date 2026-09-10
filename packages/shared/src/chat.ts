import { z } from 'zod';

/** A voice channel is a place to meet; it carries no messages. */
export type ChannelKind = 'text' | 'voice';

export interface Channel {
  id: string;
  workspaceId: string;
  name: string;
  topic: string | null;
  kind: ChannelKind;
  position: number;
  createdAt: string;
  /** Messages since this member last read the channel. */
  unread?: number;
  /** How many of those name this member. Tracked apart from `unread`
   *  because being addressed directly is worth interrupting someone for
   *  and ordinary chatter is not. */
  mentions?: number;
}

export interface MessageAuthor {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

/** Someone in a voice channel, as the channel list shows them. */
export interface VoiceOccupant {
  name: string;
  avatarUrl: string | null;
}

export interface Message {
  id: string;
  channelId: string;
  body: string;
  /** Null once the account is gone; the message itself survives. */
  author: MessageAuthor | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

/**
 * Channel names are addresses — people type `#design` — so they are normalised
 * the way a URL slug is rather than kept as free text.
 */
export function channelName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
}

const nameSchema = z
  .string()
  .transform(channelName)
  .refine((value) => value.length > 0, 'Enter a channel name using letters or numbers');

export const createChannelSchema = z.object({
  name: nameSchema,
  topic: z.string().max(200).nullish(),
  kind: z.enum(['text', 'voice']).default('text'),
});

export const updateChannelSchema = z.object({
  name: nameSchema.optional(),
  topic: z.string().max(200).nullish(),
  position: z.number().int().min(0).optional(),
});

export const createMessageSchema = z.object({
  body: z.string().trim().min(1, 'Write something first').max(4000),
});

export const updateMessageSchema = z.object({
  body: z.string().trim().min(1).max(4000),
});

export interface DocumentReference {
  id: string;
  title: string;
  icon: string | null;
  mode: 'page' | 'canvas';
}

export interface ChannelReference {
  id: string;
  name: string;
  kind: ChannelKind;
}

export interface MemberReference {
  id: string;
  name: string;
  email: string;
}

/** What a page of messages points at, resolved once. */
export interface MessageReferences {
  documents: DocumentReference[];
  channels: ChannelReference[];
  members: MemberReference[];
}

/**
 * What the chat socket pushes. Every event carries the references its message
 * needs, so a client that receives a message for a document it has never seen
 * can still render the link without another request.
 */
export type ChatEvent =
  | { type: 'message.created'; message: Message; references: MessageReferences }
  | { type: 'message.updated'; message: Message; references: MessageReferences }
  | { type: 'message.deleted'; message: Message; references: MessageReferences };

// --- references -------------------------------------------------------------

/**
 * Documents, channels and people are referenced by id inside a message, not by
 * name: `<doc:uuid>`, `<#uuid>` and `<@uuid>`. Rendering resolves them, so
 * someone changing their display name updates every message that mentions them
 * instead of leaving a stale name scattered through the history.
 */
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const REFERENCE = new RegExp(`<(?:doc:(${UUID})|#(${UUID})|@(${UUID}))>`, 'g');

export type MessageSegment =
  | { type: 'text'; value: string }
  | { type: 'document'; id: string }
  | { type: 'channel'; id: string }
  | { type: 'member'; id: string };

export function documentRef(id: string): string {
  return `<doc:${id}>`;
}

export function channelRef(id: string): string {
  return `<#${id}>`;
}

export function memberRef(id: string): string {
  return `<@${id}>`;
}

/** Splits a message body into plain runs and the references between them. */
export function parseMessage(body: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let index = 0;
  // A fresh regex per call: the global flag carries lastIndex between uses.
  const pattern = new RegExp(REFERENCE.source, 'g');

  for (let match = pattern.exec(body); match; match = pattern.exec(body)) {
    if (match.index > index) segments.push({ type: 'text', value: body.slice(index, match.index) });
    if (match[1]) segments.push({ type: 'document', id: match[1].toLowerCase() });
    else if (match[2]) segments.push({ type: 'channel', id: match[2].toLowerCase() });
    else if (match[3]) segments.push({ type: 'member', id: match[3].toLowerCase() });
    index = match.index + match[0].length;
  }
  if (index < body.length) segments.push({ type: 'text', value: body.slice(index) });
  return segments;
}

/** The ids a message points at, so a client can resolve them in one request. */
export function collectReferences(bodies: string[]): {
  documentIds: string[];
  channelIds: string[];
  userIds: string[];
} {
  const documentIds = new Set<string>();
  const channelIds = new Set<string>();
  const userIds = new Set<string>();
  for (const body of bodies) {
    for (const segment of parseMessage(body)) {
      if (segment.type === 'document') documentIds.add(segment.id);
      if (segment.type === 'channel') channelIds.add(segment.id);
      if (segment.type === 'member') userIds.add(segment.id);
    }
  }
  return { documentIds: [...documentIds], channelIds: [...channelIds], userIds: [...userIds] };
}

/** True when the message mentions this person; used to highlight it for them. */
export function mentions(body: string, userId: string): boolean {
  return parseMessage(body).some((segment) => segment.type === 'member' && segment.id === userId.toLowerCase());
}
