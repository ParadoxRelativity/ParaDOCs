import type { FastifyPluginAsync } from 'fastify';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import type { VoiceOccupant } from '@paradocs/shared';
import { query } from '../db/pool.js';
import { badRequest, notFound } from '../lib/http.js';
import { assertWorkspaceAccess } from '../plugins/session.js';
import { config } from '../config.js';

/** A call needs all three settings; one on its own is a misconfiguration. */
export function voiceEnabled(): boolean {
  return Boolean(config.livekit.url && config.livekit.apiKey && config.livekit.apiSecret);
}

/** Tokens outlive a join but not a session, so a tab left open all day reconnects. */
const TOKEN_TTL = '6h';

/**
 * The management API is HTTP even though clients dial over websockets, so the
 * ws:// URL the browser uses is rewritten for our own server-to-server calls.
 */
function roomService(): RoomServiceClient {
  const httpUrl = config.livekit.url.replace(/^ws/, 'http');
  return new RoomServiceClient(httpUrl, config.livekit.apiKey, config.livekit.apiSecret);
}

export const voiceRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get('/voice/config', async () => ({
    enabled: voiceEnabled(),
    url: config.livekit.url || null,
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
   * Mints a LiveKit access token for one voice channel.
   *
   * The room is the channel id, so a room can only be joined by someone the
   * membership check below lets through — the token is the only way in, and it
   * is scoped to exactly that room. Identity is the user id so LiveKit's own
   * participant list lines up with ours, and a second tab replaces the first
   * rather than appearing twice.
   */
  app.post<{ Params: { id: string } }>('/channels/:id/call', async (req) => {
    if (!voiceEnabled()) throw badRequest('This server has no voice service configured');

    const { rows } = await query<{ workspace_id: string; kind: string; name: string }>(
      'SELECT workspace_id, kind, name FROM channels WHERE id = $1',
      [req.params.id],
    );
    const channel = rows[0];
    if (!channel) throw notFound('Channel not found');
    if (channel.kind !== 'voice') throw badRequest('That channel is not a voice channel');
    await assertWorkspaceAccess(req, channel.workspace_id);

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
      url: config.livekit.url,
      token: await token.toJwt(),
      room: req.params.id,
      channelName: channel.name,
    };
  });
};
