import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { AccessToken, RoomServiceClient, WebhookReceiver, type WebhookEvent } from 'livekit-server-sdk';
import { ringSchema, type VoiceOccupant } from '@paradocs/shared';
import { query, type DbClient } from '../db/pool.js';
import { badRequest, notFound, parse, unauthorized } from '../lib/http.js';
import { channelAccessFor, channelParticipants, UUID } from '../lib/channels.js';
import { channelLevelSql } from '../lib/access.js';
import { onAccessChanged } from '../lib/accessEvents.js';
import { assertWorkspaceAccess } from '../plugins/session.js';
import { publishToChannel, publishToUser } from '../chat/hub.js';
import { config } from '../config.js';

/**
 * A call needs keys and somewhere to reach LiveKit. In the Docker deployment
 * all of that is provided, so voice is on unless VOICE_ENABLED=false.
 */
export function voiceEnabled(): boolean {
  const { enabled, url, internalUrl, apiKey, apiSecret } = config.livekit;
  return Boolean(enabled && apiKey && apiSecret && (url || internalUrl));
}

/**
 * Somewhere to meet in a new workspace, the way #general is somewhere to talk.
 * Only on a server with voice: elsewhere it would be a door that never opens.
 */
export async function addDefaultVoiceChannel(
  client: Pick<DbClient, 'query'>,
  workspaceId: string,
  userId: string,
): Promise<void> {
  if (!voiceEnabled()) return;
  await client.query(
    `INSERT INTO channels (workspace_id, name, topic, kind, created_by) VALUES ($1, 'lounge', $2, 'voice', $3)`,
    [workspaceId, 'Drop in to talk', userId],
  );
}

/** Tokens outlive a join but not a session, so a tab left open all day reconnects. */
const TOKEN_TTL = '6h';

/**
 * LiveKit's management API, for this server's own calls. The internal address
 * when there is one; otherwise the address browsers dial, rewritten from ws to
 * http, since the management API is plain HTTP.
 */
function roomService(): RoomServiceClient {
  const httpUrl = config.livekit.internalUrl || config.livekit.url.replace(/^ws/, 'http');
  return new RoomServiceClient(httpUrl, config.livekit.apiKey, config.livekit.apiSecret);
}

/**
 * Takes someone out of a room they may no longer be in, such as the call of a
 * group conversation they were removed from. Their token only said what was
 * allowed when it was minted. Nothing to do when they are not in it.
 */
export async function removeFromCall(room: string, userId: string, log: FastifyBaseLogger): Promise<void> {
  if (!voiceEnabled()) return;
  try {
    const service = roomService();
    const participants = await service.listParticipants(room);
    if (participants.some((p) => p.identity === userId)) await service.removeParticipant(room, userId);
  } catch (err) {
    // No room yet is the usual case, and a call that cannot be reached is not
    // worth failing the change that prompted this.
    log.debug({ err, room }, 'could not check the call for someone who left');
  }
}

/**
 * The address a browser dials to join a call: LIVEKIT_URL when it is set, or
 * null when this server relays signalling under /rtc, which means "the address
 * this page was loaded from".
 *
 * The server does not try to work that address out from the request. Between
 * the browser and here there can be Caddy, another reverse proxy, or the
 * desktop app's loopback proxy, and any of them may rewrite the Host header or
 * drop the forwarded protocol — which hands the browser an address it cannot
 * reach, or plain ws:// on an HTTPS page. Only the page knows its own origin
 * for certain.
 */
function signallingUrl(): string | null {
  return config.livekit.url || null;
}

type Participant = Awaited<ReturnType<RoomServiceClient['listParticipants']>>[number];

/** Someone in a room, as the channel list shows them. */
function toOccupant(p: Participant): VoiceOccupant {
  return { name: p.name || p.identity, avatarUrl: p.attributes?.avatarUrl || null };
}

/**
 * Brings the people in a workspace's calls into line with who may be there
 * now: anyone locked out of a voice channel is removed from its room, anyone
 * cut down to listening loses the right to speak, and anyone allowed to speak
 * again gets it back. A token only says what was allowed when it was minted.
 */
async function enforceVoiceAccess(workspaceId: string): Promise<void> {
  if (!voiceEnabled()) return;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM channels WHERE workspace_id = $1 AND kind = 'voice'`,
    [workspaceId],
  );
  if (rows.length === 0) return;
  const service = roomService();
  const rooms = await service.listRooms(rows.map((r) => r.id));
  for (const room of rooms.filter((r) => r.numParticipants > 0)) {
    for (const participant of await service.listParticipants(room.name)) {
      const access = await channelAccessFor(participant.identity, room.name);
      if (!access) {
        await service.removeParticipant(room.name, participant.identity);
        continue;
      }
      const canSpeak = access.level >= 2;
      if (participant.permission && participant.permission.canPublish !== canSpeak) {
        await service.updateParticipant(room.name, participant.identity, undefined, {
          canPublish: canSpeak,
          canSubscribe: true,
          canPublishData: true,
        });
      }
    }
  }
}

export const voiceRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  const stopEnforcing = onAccessChanged((workspaceId) => {
    enforceVoiceAccess(workspaceId).catch((err) =>
      app.log.warn({ err, workspaceId }, 'could not apply an access change to calls in progress'),
    );
  });
  app.addHook('onClose', async () => stopEnforcing());

  app.get('/voice/config', async () => ({
    enabled: voiceEnabled(),
    url: voiceEnabled() ? signallingUrl() : null,
  }));

  /**
   * Who is currently in each voice channel of a workspace.
   *
   * Without this a voice channel is a closed door: you cannot tell whether
   * anyone is inside until you join, which is the one thing you want to know
   * before joining. Rooms exist only while occupied, so anything not listed is
   * simply empty.
   */
  app.get<{ Params: { id: string } }>('/workspaces/:id/voice/participants', async (req) => {
    const role = await assertWorkspaceAccess(req, req.params.id, 'viewer', 'chat');
    const occupancy: Record<string, VoiceOccupant[]> = {};
    if (!voiceEnabled()) return occupancy;

    // Who is in a locked channel is only for those who may see it.
    const { rows } = await query<{ id: string }>(
      `SELECT c.id FROM channels c
        WHERE c.workspace_id = $1 AND c.kind = 'voice' AND ${channelLevelSql('$2', '$3')} > 0`,
      [req.params.id, req.user!.id, role],
    );
    if (rows.length === 0) return occupancy;

    const service = roomService();
    let rooms: { name: string; numParticipants: number }[];
    try {
      rooms = await service.listRooms(rows.map((r) => r.id));
    } catch (err) {
      // A voice service that is down must not take the channel list with it.
      req.log.warn({ err }, 'could not list voice rooms');
      return occupancy;
    }

    await Promise.all(
      rooms
        .filter((room) => room.numParticipants > 0)
        .map(async (room) => {
          try {
            const participants = await service.listParticipants(room.name);
            occupancy[room.name] = participants.map(toOccupant);
          } catch {
            // Fall back to the count if the room went away mid-request.
            occupancy[room.name] = Array.from({ length: room.numParticipants }, () => ({
              name: 'Someone',
              avatarUrl: null,
            }));
          }
        }),
    );
    return occupancy;
  });

  /**
   * Mints a LiveKit access token for a voice channel or a direct conversation.
   *
   * The room is the channel id, so a room can only be joined by someone the
   * access check below lets through — the token is the only way in, and it is
   * scoped to exactly that room. For a direct conversation that check admits
   * only the people in it. Identity is the user id so LiveKit's own
   * participant list lines up with ours, and a second tab replaces the first
   * rather than appearing twice.
   */
  app.post<{ Params: { id: string } }>('/channels/:id/call', async (req) => {
    if (!voiceEnabled()) throw badRequest('This server has no voice service configured');

    const access = await channelAccessFor(req.user!.id, req.params.id);
    if (!access) throw notFound('Channel not found');
    if (access.kind !== 'voice' && access.kind !== 'direct') throw badRequest('That channel is not a voice channel');
    // A lock can let someone listen in without speaking.
    const canSpeak = access.level >= 2;

    const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
      identity: req.user!.id,
      name: req.user!.name,
      // Carried on the participant, so everyone in the call can draw the picture.
      attributes: req.user!.avatarUrl ? { avatarUrl: req.user!.avatarUrl } : undefined,
      ttl: TOKEN_TTL,
    });
    token.addGrant({
      room: req.params.id,
      roomJoin: true,
      canPublish: canSpeak,
      canSubscribe: true,
      // Screenshare and camera are published as ordinary tracks; data is used
      // by the client SDK for its own signalling.
      canPublishData: true,
    });

    return {
      url: signallingUrl(),
      token: await token.toJwt(),
      room: req.params.id,
      channelName: access.name,
      canSpeak,
    };
  });

  /**
   * Rings the other people in a direct conversation, or settles a ring.
   *
   * The call itself is an ordinary room; ringing is only how the other people
   * learn someone is waiting in it. It travels over each person's chat
   * sockets, so every window they have open rings, and answering or declining
   * in one quiets the rest.
   */
  app.post<{ Params: { id: string } }>('/channels/:id/ring', async (req, reply) => {
    const input = parse(ringSchema, req.body);
    const access = await channelAccessFor(req.user!.id, req.params.id);
    if (!access) throw notFound('Channel not found');
    if (access.kind !== 'direct') throw badRequest('Only a direct conversation can ring');

    const self = req.user!;
    const participants = await channelParticipants(req.params.id);

    if (input.action === 'start') {
      if (!voiceEnabled()) throw badRequest('This server has no voice service configured');
      for (const userId of participants) {
        if (userId === self.id) continue;
        publishToUser(userId, {
          type: 'call.ringing',
          workspaceId: access.workspaceId,
          channelId: req.params.id,
          caller: { id: self.id, name: self.name, avatarUrl: self.avatarUrl },
          video: input.video === true,
        });
      }
    } else {
      const reason = input.action === 'cancel' ? 'cancelled' : input.action === 'answer' ? 'answered' : 'declined';
      // Everyone in the conversation hears this: the caller learns the answer,
      // and the other windows of whoever was rung stop ringing.
      for (const userId of participants) {
        publishToUser(userId, { type: 'call.ended', channelId: req.params.id, reason, userId: self.id });
      }
    }
    reply.status(204);
  });
};

/** What LiveKit reports that changes who is in a room. */
const OCCUPANCY_EVENTS = new Set(['participant_joined', 'participant_left', 'participant_connection_aborted', 'room_finished']);

/**
 * Each room's announcement in progress. Two changes landing together are
 * worked out one after the other, so the later list is the one sent last.
 */
const announcing = new Map<string, Promise<void>>();

/**
 * Tells everyone with a workspace open who is now in one of its voice channels.
 *
 * Direct calls are left out: who is on a call in a private conversation is nobody
 * else's business, and the channel list does not show them anyway.
 */
async function announceOccupancy(event: WebhookEvent, room: string): Promise<void> {
  if (!UUID.test(room)) return;
  const { rows } = await query<{ workspace_id: string }>(
    `SELECT workspace_id FROM channels WHERE id = $1 AND kind = 'voice'`,
    [room],
  );
  const workspaceId = rows[0]?.workspace_id;
  if (!workspaceId) return;

  let participants: Participant[] = [];
  if (event.event !== 'room_finished') {
    try {
      participants = await roomService().listParticipants(room);
    } catch {
      // The room closed on the way; nobody is in it.
    }
    // The event is the last word on the person it is about, whatever the list
    // caught of them.
    const who = event.participant;
    if (who) {
      participants = participants.filter((p) => p.identity !== who.identity);
      if (event.event === 'participant_joined') participants.push(who);
    }
  }

  // To the channel's subscribers, each checked when they subscribed and again
  // whenever access changes, so a locked room's occupants stay its business.
  publishToChannel(room, {
    type: 'voice.changed',
    workspaceId,
    channelId: room,
    occupants: participants.map(toOccupant),
  });
}

/**
 * LiveKit's webhook: joins and leaves, pushed to the chat sockets.
 *
 * Outside the signed-in routes, since LiveKit has no session. It signs each
 * request with the key pair this server shares with it, which is checked
 * before anything is believed.
 */
export const voiceWebhookRoutes: FastifyPluginAsync = async (app) => {
  // The signature covers the exact bytes sent, so the body stays text.
  app.addContentTypeParser('application/webhook+json', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.post('/voice/webhook', async (req, reply) => {
    if (!voiceEnabled()) throw notFound();
    if (typeof req.body !== 'string') throw badRequest('Expected a LiveKit webhook');

    let event: WebhookEvent;
    try {
      const receiver = new WebhookReceiver(config.livekit.apiKey, config.livekit.apiSecret);
      event = await receiver.receive(req.body, req.headers.authorization);
    } catch {
      throw unauthorized('Webhook signature is not valid');
    }

    const room = event.room?.name;
    if (room && OCCUPANCY_EVENTS.has(event.event)) {
      // Answered straight away: LiveKit does not wait long, and the work here
      // is asking LiveKit itself a question.
      queueAnnouncement(room, event, req.log);
    }
    reply.status(204);
  });
};

function queueAnnouncement(room: string, event: WebhookEvent, log: FastifyBaseLogger): void {
  const next = (announcing.get(room) ?? Promise.resolve())
    .then(() => announceOccupancy(event, room))
    .catch((err) => log.warn({ err, room }, 'could not announce voice occupancy'));
  announcing.set(room, next);
  void next.then(() => {
    if (announcing.get(room) === next) announcing.delete(room);
  });
}
