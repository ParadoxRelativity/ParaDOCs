import { z } from 'zod';

/**
 * AI connections: assistants such as Claude, ChatGPT or Cursor reaching
 * ParaDOCs through its MCP server, as the person who connected them.
 *
 * A connection is either a personal access key, pasted into a client that takes
 * one (bring your own key), or a sign-in the client did itself through the
 * browser, as claude.ai and ChatGPT do for a custom connector. Either way it
 * can do no more than its person, may be held to one workspace and to reading,
 * and is revoked on its own.
 */

/** The MCP server's address, relative to the server's own. */
export const MCP_PATH = '/api/mcp';

/** What a personal access key starts with, so one pasted in the wrong place is recognisable. */
export const AI_KEY_PREFIX = 'pdk_';

export type AiConnectionKind = 'key' | 'oauth';

export interface AiConnection {
  id: string;
  kind: AiConnectionKind;
  /** A key's name, or the name the client signed in as, such as "Claude". */
  name: string;
  /** The key's last few characters, to tell keys apart by. Empty for a sign-in. */
  hint: string;
  /** Null: every workspace the person is in. */
  workspace: { id: string; name: string } | null;
  /** Off: it can read, and change nothing. */
  canWrite: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

/** The signed-in person's connections, and whether the server allows any. */
export interface AiConnections {
  /** Off: a server administrator has not turned AI connections on, and none does anything. */
  enabled: boolean;
  connections: AiConnection[];
}

/** A key just made, with the secret itself. It is never shown again. */
export interface CreatedAiKey extends AiConnection {
  key: string;
}

export const createAiKeySchema = z.object({
  name: z.string().trim().min(1, 'Name it after what will use it').max(80),
  workspaceId: z.string().uuid().nullish(),
  canWrite: z.boolean().default(false),
});

export type CreateAiKeyInput = z.input<typeof createAiKeySchema>;

/** What the consent page shows about a client asking to connect. */
export interface OAuthRequestInfo {
  clientName: string;
  /** Where the person is sent back to, shown so they can tell a stranger from the app they meant. */
  redirectHost: string;
}

/** The person's answer on the consent page. */
export const oauthDecisionSchema = z.object({
  clientId: z.string().min(1).max(200),
  redirectUri: z.string().min(1).max(2000),
  codeChallenge: z.string().min(43).max(128),
  codeChallengeMethod: z.literal('S256'),
  state: z.string().max(2000).optional(),
  approve: z.boolean(),
  workspaceId: z.string().uuid().nullish(),
  canWrite: z.boolean().default(false),
});

export type OAuthDecision = z.input<typeof oauthDecisionSchema>;
