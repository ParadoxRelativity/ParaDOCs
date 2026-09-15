import { z } from 'zod';

import type { PresenceStatus } from './presence.js';
import type { AccessMode, Permission } from './types.js';

/**
 * A voice channel is a place to meet; it carries no messages. A direct
 * conversation is between two people, carries messages and can hold a call.
 */
export type ChannelKind = 'text' | 'voice' | 'direct';

export interface Channel {
  id: string;
  workspaceId: string;
  /** Empty for a direct conversation, which is named for `peer`. */
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
  /** In a direct conversation, the other person. Null once their account is gone. */
  peer?: MessageAuthor | null;
  /** In a direct conversation, when the latest message was sent. */
  lastMessageAt?: string | null;
  /** A named channel's access setting. A channel has no folder, so it never inherits. */
  access?: Exclude<AccessMode, 'inherit'>;
  /**
   * What the signed-in person may do: `view` reads a text channel or listens in
   * a voice one, `edit` also posts or speaks. Absent means `edit`.
   */
  permission?: Permission;
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
  /** May be empty when the message is only files. */
  body: string;
  /** Null once the account is gone; the message itself survives. */
  author: MessageAuthor | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  /** In the order they were added to the message. */
  attachments: MessageAttachment[];
  /** One entry per emoji, in the order each was first used. */
  reactions: MessageReaction[];
}

/** A file shared in a message. */
export interface MessageAttachment {
  id: string;
  filename: string;
  /** As reported by the uploader's browser, so for display only. */
  mimeType: string;
  byteSize: number;
  url: string;
  /** Pixel size of an image or video, when the uploader could measure it. */
  width: number | null;
  height: number | null;
}

export interface MessageReaction {
  emoji: string;
  /** Everyone who reacted with this emoji, earliest first. */
  users: { id: string; name: string }[];
}

/** What the server allows for uploads anywhere: chat, documents and canvases. */
export interface UploadConfig {
  maxBytes: number;
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

export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/** Distinct emoji on one message. Past this, people can still join existing reactions. */
export const MAX_REACTIONS_PER_MESSAGE = 20;

export const createMessageSchema = z
  .object({
    body: z.string().trim().max(4000).default(''),
    attachmentIds: z
      .array(z.string().uuid())
      .max(MAX_ATTACHMENTS_PER_MESSAGE, `A message can carry up to ${MAX_ATTACHMENTS_PER_MESSAGE} files`)
      .default([])
      .refine((ids) => new Set(ids).size === ids.length, 'The same file was attached twice'),
  })
  .refine((message) => message.body.length > 0 || message.attachmentIds.length > 0, {
    message: 'Write something first',
    path: ['body'],
  });

/** An edit may empty the text only of a message that has files; the route checks. */
export const updateMessageSchema = z.object({
  body: z.string().trim().max(4000),
});

export const reactionSchema = z.object({
  emoji: z.string().max(32).refine(isEmoji, 'A reaction has to be a single emoji'),
});

// --- emoji and files ----------------------------------------------------------

/**
 * One emoji, including skin tones, keycaps, flags and joined sequences such as
 * families. Used to keep reactions to emoji rather than arbitrary text.
 */
const EMOJI =
  /^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}[\u{E0020}-\u{E007F}]*(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}[\u{E0020}-\u{E007F}]*(?:\uFE0F|\p{Emoji_Modifier})?)*)$/u;

export function isEmoji(value: string): boolean {
  return EMOJI.test(value);
}

export type AttachmentKind = 'image' | 'video' | 'audio' | 'file';

const KIND_BY_EXTENSION: Record<string, AttachmentKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  mp4: 'video',
  m4v: 'video',
  webm: 'video',
  ogv: 'video',
  mov: 'video',
  mp3: 'audio',
  m4a: 'audio',
  aac: 'audio',
  ogg: 'audio',
  oga: 'audio',
  opus: 'audio',
  wav: 'audio',
  flac: 'audio',
};

/**
 * How a stored file can be shown, judged by its extension. The server sends a
 * file with the content type its extension implies, so this — not the type the
 * uploader's browser claimed — is what the browser will actually receive.
 * SVG is deliberately not an image here: it can carry script.
 */
export function attachmentKind(pathOrName: string): AttachmentKind {
  const match = /\.([a-z0-9]+)$/i.exec(pathOrName.split(/[?#]/)[0]);
  return (match && KIND_BY_EXTENSION[match[1].toLowerCase()]) || 'file';
}

/** Stands in for the text of a message that is only files, in previews. */
export function attachmentSummary(count: number): string {
  return count === 1 ? 'Shared a file' : `Shared ${count} files`;
}

export interface DocumentReference {
  id: string;
  title: string;
  icon: string | null;
  mode: 'page' | 'canvas';
}

/**
 * A spreadsheet carries no mode: there is only one kind of grid, so there is
 * nothing for the chip to choose an icon by beyond the one the sheet was given.
 */
export interface SpreadsheetReference {
  id: string;
  title: string;
  icon: string | null;
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
  spreadsheets: SpreadsheetReference[];
  channels: ChannelReference[];
  members: MemberReference[];
}

/**
 * What the chat socket pushes. Every event carries the references its message
 * needs, so a client that receives a message for a document it has never seen
 * can still render the link without another request.
 */
interface MessageEventFields {
  workspaceId: string;
  /** A direct conversation's messages reach its people wherever they are, not only where it is open. */
  channelKind: ChannelKind;
  message: Message;
  references: MessageReferences;
}

export type ChatMessageEvent =
  | ({ type: 'message.created' } & MessageEventFields)
  | ({ type: 'message.updated' } & MessageEventFields)
  | ({ type: 'message.deleted' } & MessageEventFields);

export interface CallCaller {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/**
 * Ringing for a call in a direct conversation. The call itself is an ordinary
 * room; these only tell the other person someone is waiting in it, and tell
 * everyone when that has been settled.
 */
export type CallEvent =
  | { type: 'call.ringing'; workspaceId: string; channelId: string; caller: CallCaller; video: boolean }
  | {
      type: 'call.ended';
      channelId: string;
      reason: 'answered' | 'declined' | 'cancelled';
      /** Who answered, declined or hung up. */
      userId: string;
    };

/** What everyone with a workspace open hears about it. */
export type WorkspaceEvent =
  | { type: 'presence.changed'; workspaceId: string; userId: string; status: PresenceStatus }
  | { type: 'channels.changed'; workspaceId: string }
  | { type: 'members.changed'; workspaceId: string }
  /** Who can see what has changed: a lock, a team, or someone's role. Refetch what is shown. */
  | { type: 'access.changed'; workspaceId: string }
  /** Everyone now in a voice channel; an empty list means it has emptied. */
  | { type: 'voice.changed'; workspaceId: string; channelId: string; occupants: VoiceOccupant[] };

/**
 * Someone typing, or no longer typing, in a channel or direct conversation.
 * Nothing about it is stored: it lasts only as long as it keeps being repeated.
 */
export interface TypingEvent {
  type: 'typing';
  workspaceId: string;
  channelId: string;
  user: { id: string; name: string };
  typing: boolean;
}

export type ChatEvent = ChatMessageEvent | CallEvent | WorkspaceEvent | TypingEvent;

/** How often a client repeats that someone is still typing. */
export const TYPING_INTERVAL_MS = 3_000;

/**
 * How long a typing indicator lasts without being repeated: twice the interval,
 * so one late update does not make it flicker, and short enough that someone
 * who closes their laptop mid-sentence does not seem to type forever.
 */
export const TYPING_TIMEOUT_MS = 6_000;

export const openDirectSchema = z.object({
  userId: z.string().uuid(),
});

export const ringSchema = z.object({
  action: z.enum(['start', 'cancel', 'answer', 'decline']),
  video: z.boolean().default(false),
});

/** How long a call rings before it counts as unanswered. */
export const RING_TIMEOUT_MS = 45_000;

// --- references -------------------------------------------------------------

/**
 * Documents, spreadsheets, channels and people are referenced by id inside a
 * message, not by name: `<doc:uuid>`, `<sheet:uuid>`, `<#uuid>` and `<@uuid>`.
 * Rendering resolves them, so someone changing their display name updates every
 * message that mentions them instead of leaving a stale name scattered through
 * the history.
 *
 * A spreadsheet gets a token of its own rather than riding along as a document
 * in another mode, for the same reason it has a table of its own: it is not one.
 * The two resolve from different places and open to different apps, and one
 * token covering both would have to carry which it meant anyway.
 */
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const REFERENCE = new RegExp(`<(?:doc:(${UUID})|sheet:(${UUID})|#(${UUID})|@(${UUID}))>`, 'g');

export type MessageSegment =
  | { type: 'text'; value: string }
  | { type: 'document'; id: string }
  | { type: 'spreadsheet'; id: string }
  | { type: 'channel'; id: string }
  | { type: 'member'; id: string };

export function documentRef(id: string): string {
  return `<doc:${id}>`;
}

export function spreadsheetRef(id: string): string {
  return `<sheet:${id}>`;
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
    else if (match[2]) segments.push({ type: 'spreadsheet', id: match[2].toLowerCase() });
    else if (match[3]) segments.push({ type: 'channel', id: match[3].toLowerCase() });
    else if (match[4]) segments.push({ type: 'member', id: match[4].toLowerCase() });
    index = match.index + match[0].length;
  }
  if (index < body.length) segments.push({ type: 'text', value: body.slice(index) });
  return segments;
}

/** The ids a message points at, so a client can resolve them in one request. */
export function collectReferences(bodies: string[]): {
  documentIds: string[];
  spreadsheetIds: string[];
  channelIds: string[];
  userIds: string[];
} {
  const documentIds = new Set<string>();
  const spreadsheetIds = new Set<string>();
  const channelIds = new Set<string>();
  const userIds = new Set<string>();
  for (const body of bodies) {
    for (const segment of parseMessage(body)) {
      if (segment.type === 'document') documentIds.add(segment.id);
      if (segment.type === 'spreadsheet') spreadsheetIds.add(segment.id);
      if (segment.type === 'channel') channelIds.add(segment.id);
      if (segment.type === 'member') userIds.add(segment.id);
    }
  }
  return {
    documentIds: [...documentIds],
    spreadsheetIds: [...spreadsheetIds],
    channelIds: [...channelIds],
    userIds: [...userIds],
  };
}

/**
 * A message body as plain text, for places markup cannot go — a notification,
 * a preview line. References read as the names they resolve to, not raw tokens.
 */
export function messagePreview(body: string, references: MessageReferences): string {
  const documents = new Map(references.documents.map((d) => [d.id, d]));
  const spreadsheets = new Map(references.spreadsheets.map((s) => [s.id, s]));
  const channels = new Map(references.channels.map((c) => [c.id, c]));
  const members = new Map(references.members.map((m) => [m.id, m]));

  return parseMessage(body)
    .map((segment) => {
      if (segment.type === 'text') return segment.value;
      if (segment.type === 'document') return documents.get(segment.id)?.title ?? 'a document';
      if (segment.type === 'spreadsheet') return spreadsheets.get(segment.id)?.title ?? 'a spreadsheet';
      if (segment.type === 'channel') {
        const channel = channels.get(segment.id);
        return channel ? `#${channel.name}` : 'a channel';
      }
      const member = members.get(segment.id);
      return member ? `@${member.name}` : '@someone';
    })
    .join('')
    .trim();
}

/** True when the message mentions this person; used to highlight it for them. */
export function mentions(body: string, userId: string): boolean {
  return parseMessage(body).some((segment) => segment.type === 'member' && segment.id === userId.toLowerCase());
}
