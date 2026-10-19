/**
 * Presenting live to the workspace (PARA-99): what the presenter broadcasts
 * and what the audience is told, carried by the chat socket.
 *
 * The audience mirrors the presenter's ShowState ({slideId, step, blank}) and
 * may browse on their own, but only the presenter's socket can move the show.
 */

import type { ShowBlank, ShowState } from './slideShow.js';

export interface LiveShowInfo {
  presentationId: string;
  workspaceId: string;
  title: string;
  presenter: { id: string; name: string };
  /** The channel it was announced in, which also puts a join banner on that channel's voice call. */
  channelId: string | null;
  startedAt: string;
  /** How many people are following, the presenter not counted. */
  viewers: number;
}

/** What the presenter's client sends. */
export type LiveShowRequest =
  | { type: 'show.start'; presentationId: string; channelId?: string | null }
  | { type: 'show.state'; presentationId: string; state: ShowState }
  | { type: 'show.end'; presentationId: string }
  | { type: 'show.join'; presentationId: string }
  | { type: 'show.leave'; presentationId: string };

export type LiveShowRefusal = 'not-live' | 'forbidden' | 'busy' | 'unavailable';

/** What the socket pushes about a live show; `shows.changed` goes to the whole workspace, ids only. */
export type LiveShowEvent =
  /** To the presenter: the session is running. */
  | { type: 'show.started'; presentationId: string; show: LiveShowInfo }
  /** To someone who joined: the show and where it is now. */
  | { type: 'show.joined'; presentationId: string; show: LiveShowInfo; state: ShowState; seq: number }
  | { type: 'show.state'; presentationId: string; state: ShowState; seq: number }
  | { type: 'show.viewers'; presentationId: string; viewers: number }
  | { type: 'show.ended'; presentationId: string }
  | { type: 'show.refused'; presentationId: string; reason: LiveShowRefusal; message: string }
  /** A show started or ended: ask for the list again. */
  | { type: 'shows.changed'; workspaceId: string; presentationId: string };

const MAX_ID = 100;
/** More build steps than any slide has. */
export const MAX_LIVE_STEP = 1000;

/** A ShowState from the wire, or null when it is not one. Free text is bounded and `jump` is never carried. */
export function normalizeLiveState(input: unknown): ShowState | null {
  if (!input || typeof input !== 'object') return null;
  const { slideId, step, blank } = input as Record<string, unknown>;
  if (slideId !== null && (typeof slideId !== 'string' || slideId.length === 0 || slideId.length > MAX_ID)) return null;
  if (typeof step !== 'number' || !Number.isInteger(step) || step < 0 || step > MAX_LIVE_STEP) return null;
  if (blank !== null && blank !== 'black' && blank !== 'white') return null;
  return { slideId, step, blank: blank as ShowBlank, jump: '' };
}

/** Whether two positions are the same place in the show. */
export function sameLiveState(a: ShowState, b: ShowState): boolean {
  return a.slideId === b.slideId && a.step === b.step && a.blank === b.blank;
}
