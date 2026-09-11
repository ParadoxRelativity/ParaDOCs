import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { ringSchema, type VoiceOccupant } from '@paradocs/shared';
import { query, type DbClient } from '../db/pool.js';
import { badRequest, notFound, parse } from '../lib/http.js';
import { channelAccessFor, channelParticipants } from '../lib/channels.js';
import { assertWorkspaceAccess } from '../plugins/session.js';
import { publishToUser } from '../chat/hub.js';
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
 * The address a browser dials to join a call. LIVEKIT_URL when it is set;
 * otherwise this server's own address, as the browser reached it, since this
 * server relays signalling under /rtc.
 */
function signallingUrl(req: FastifyRequest): string {
  if (config.livekit.url) return config.livekit.url;
  // Behind Caddy the request arrives here over plain HTTP, but the browser used
  // HTTPS and may only open wss://. The header can be forged, but only by the
  // person asking, about the answer they get.
  const forwarded = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const secure = (forwarded || req.protocol) === 'https';
  return `${secure ? 'wss' : 'ws'}://${req.headers.host ?? req.hostname}`;
}

export const voiceRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get('/voice/config', async (req) => ({
    enabled: voiceEnabled(),
    url: voiceEnabled() ? signallingUrl(req) : null,
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
    await assertWorkspaceAccess(req, req.params.id);
    const occupancy: Record<string, VoiceOccupant[]> = {};
    if (!voiceEnabled()) return occupancy;

    const { rows } = await query<{ id: string }>(
      `SELECT id FROM channels WHERE workspace_id = $1 AND kind = 'voice'`,
      [req.params.id],
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
            occupancy[room.name] = participants.map((p) => ({
              name: p.name || p.identity,
              avatarUrl: p.attributes?.avatarUrl || null,
            }));
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
   * only the two people in it. Identity is the user id so LiveKit's own
   * participant list lines up with ours, and a second tab replaces the first
   * rather than appearing twice.
   */
  app.post<{ Params: { id: string } }>('/channels/:id/call', async (req) => {
    if (!voiceEnabled()) throw badRequest('This server has no voice service configured');

    const access = await channelAccessFor(req.user!.id, req.params.id);
    if (!access) throw notFound('Channel not found');
    if (access.kind !== 'voice' && access.kind !== 'direct') throw badRequest('That channel is not a voice channel');

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
      canPublish: true,
      canSubscribe: true,
      // Screenshare and camera are published as ordinary tracks; data is used
      // by the client SDK for its own signalling.
      canPublishData: true,
    });

    return {
      url: signallingUrl(req),
      token: await token.toJwt(),
      room: req.params.id,
      channelName: access.name,
    };
  });

  /**
   * Rings the other person in a direct conversation, or settles a ring.
   *
   * The call itself is an ordinary room; ringing is only how the other person
   * learns someone is waiting in it. It travels over each person's chat
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
