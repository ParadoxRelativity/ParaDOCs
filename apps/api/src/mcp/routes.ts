import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { MCP_PATH } from '@paradocs/shared';
import { publicOrigin, touchConnection } from '../lib/aiTokens.js';
import { notFound } from '../lib/http.js';
import { mcpLimits } from '../lib/rateLimit.js';
import { serverVersion } from '../lib/releases.js';
import { getServerSettings } from '../lib/serverSettings.js';
import { PROMPTS, ToolError, describeTool, getPrompt, runTool, toolsFor, type ToolContext } from './tools.js';

/**
 * The MCP server: how AI assistants reach ParaDOCs.
 *
 * It speaks the Model Context Protocol's Streamable HTTP transport, statelessly:
 * each POST carries JSON-RPC and is answered with JSON, with no session to keep
 * and no stream held open, since nothing here is pushed to a client unasked.
 * Callers authenticate with an AI connection's key or access token, never a
 * browser session. Off until a server administrator turns on aiConnections.
 */

/** Newest first. A client asking for one of these gets it; anything else gets the newest. */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = [
  'ParaDOCs is a self-hosted workspace of documents, spreadsheets, chat channels, and project boards and queues of work items.',
  'You act as the person who connected you, and see only what they can.',
  'Name things as a person would: workspaces and projects by name, projects by key (ENG), work items by key (ENG-12), statuses and types by name as get_project lists them.',
  'Start with search or find_work_items when you do not know where something is.',
].join(' ');

/** An assistant or a script calling from anywhere; it is the token, not the origin, that is trusted. */
const OPEN_CORS = {
  cors: {
    origin: '*',
    credentials: false,
    exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id'],
  },
};

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const METHOD_NOT_FOUND = -32601;
const INVALID_REQUEST = -32600;
const INVALID_PARAMS = -32602;

function paramsOf(message: RpcRequest): Record<string, unknown> {
  return message.params && typeof message.params === 'object' && !Array.isArray(message.params)
    ? (message.params as Record<string, unknown>)
    : {};
}

async function answer(ctx: ToolContext, message: RpcRequest, req: FastifyRequest): Promise<unknown> {
  const params = paramsOf(message);
  switch (message.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: { name: 'paradocs', title: 'ParaDOCs', version: serverVersion ?? '0.0.0' },
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: toolsFor(ctx.ai).map(describeTool) };
    case 'tools/call': {
      if (typeof params.name !== 'string') throw new RpcError(INVALID_PARAMS, 'Say which tool to call');
      try {
        const text = await runTool(ctx, params.name, params.arguments);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        // A tool that could not do what was asked says so to the assistant,
        // which can correct itself; only a fault in the server is logged.
        if (!(err instanceof ToolError)) req.log.error({ err, tool: params.name }, 'MCP tool failed');
        const text = err instanceof ToolError ? err.message : 'Something went wrong on the server. Try again.';
        return { content: [{ type: 'text', text }], isError: true };
      }
    }
    case 'prompts/list':
      return { prompts: PROMPTS };
    case 'prompts/get': {
      if (typeof params.name !== 'string') throw new RpcError(INVALID_PARAMS, 'Say which prompt');
      const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, string>) : {};
      try {
        return await getPrompt(ctx, params.name, args);
      } catch (err) {
        if (err instanceof ToolError) throw new RpcError(INVALID_PARAMS, err.message);
        throw err;
      }
    }
    default:
      throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${String(message.method)}`);
  }
}

/** One JSON-RPC message's reply, or nothing for a notification. */
async function handle(ctx: ToolContext, message: unknown, req: FastifyRequest): Promise<unknown> {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Expected a JSON-RPC message' } };
  }
  const rpc = message as RpcRequest;
  // A notification, or a client's reply to something: neither is answered.
  if (rpc.id === undefined || rpc.method === undefined) return undefined;
  try {
    return { jsonrpc: '2.0', id: rpc.id, result: await answer(ctx, rpc, req) };
  } catch (err) {
    if (err instanceof RpcError) return { jsonrpc: '2.0', id: rpc.id, error: { code: err.code, message: err.message } };
    req.log.error({ err, method: rpc.method }, 'MCP request failed');
    return { jsonrpc: '2.0', id: rpc.id, error: { code: -32603, message: 'Internal error' } };
  }
}

/** Where a client learns how to sign in, per RFC 9728. */
export function resourceMetadataUrl(req: FastifyRequest): string {
  return `${publicOrigin(req)}/.well-known/oauth-protected-resource${MCP_PATH}`;
}

function challenge(req: FastifyRequest, reply: FastifyReply, invalid: boolean) {
  const error = invalid ? 'error="invalid_token", ' : '';
  reply
    .status(401)
    .header('WWW-Authenticate', `Bearer ${error}resource_metadata="${resourceMetadataUrl(req)}"`)
    .send({ error: invalid ? 'That token is not valid or has expired' : 'Connect with a ParaDOCs AI key, or sign in' });
}

export const mcpRoutes: FastifyPluginAsync = async (app) => {
  app.options('/mcp', { config: OPEN_CORS }, async (_req, reply) => reply.status(204).send());

  app.post('/mcp', { config: OPEN_CORS, bodyLimit: 1024 * 1024 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    // Off looks the same as an address that does not exist.
    if (!(await getServerSettings()).aiConnections) throw notFound();
    // Only an AI connection gets in; a browser's session cookie never does.
    if (!req.ai || !req.user) return challenge(req, reply, Boolean(req.headers.authorization));
    mcpLimits.check(req.ai.connectionId);
    await touchConnection(req.ai.connectionId);

    const ctx: ToolContext = {
      app,
      authorization: req.headers.authorization!,
      userId: req.user.id,
      ai: req.ai,
      origin: publicOrigin(req),
    };
    const body = req.body;
    if (Array.isArray(body)) {
      const replies = (await Promise.all(body.map((m) => handle(ctx, m, req)))).filter((r) => r !== undefined);
      if (replies.length === 0) return reply.status(202).send();
      return replies;
    }
    const replied = await handle(ctx, body, req);
    if (replied === undefined) return reply.status(202).send();
    return replied;
  });

  // Nothing is pushed to a client unasked, so there is no stream to open, and
  // no session to end.
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({
      method,
      url: '/mcp',
      config: OPEN_CORS,
      handler: async (_req, reply) => reply.status(405).header('Allow', 'POST').send({ error: 'Send JSON-RPC with POST' }),
    });
  }
};
