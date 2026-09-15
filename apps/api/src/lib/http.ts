import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodSchema } from 'zod';

/** An error carrying the HTTP status the client should see. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export const badRequest = (m: string) => new HttpError(400, m, 'bad_request');
export const unauthorized = (m = 'Not signed in') => new HttpError(401, m, 'unauthorized');
export const forbidden = (m = 'Not allowed') => new HttpError(403, m, 'forbidden');
export const notFound = (m = 'Not found') => new HttpError(404, m, 'not_found');
export const conflict = (m: string) => new HttpError(409, m, 'conflict');

/** Parses a body/query with zod, converting validation failures into 400s. */
export function parse<T>(schema: ZodSchema<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (err) {
    if (err instanceof ZodError) {
      const detail = err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
      throw badRequest(detail);
    }
    throw err;
  }
}

/**
 * Several endpoints take no body but are still POSTed with a JSON content-type
 * (logout, invite accept). Fastify rejects an empty body outright, so treat it
 * as an empty object rather than a 400.
 */
export function registerJsonBodyParser(app: FastifyInstance): void {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = (body as string).trim();
    if (!text) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new HttpError(400, 'Body is not valid JSON', 'bad_request'), undefined);
    }
  });
}

export function registerErrorHandler(app: {
  setErrorHandler: (fn: (err: Error, req: FastifyRequest, reply: FastifyReply) => void) => void;
}) {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      reply.status(err.statusCode).send({ error: err.message, code: err.code });
      return;
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      reply.status(status).send({ error: err.message });
      return;
    }
    req.log.error({ err }, 'unhandled error');
    reply.status(500).send({ error: 'Internal server error' });
  });
}
