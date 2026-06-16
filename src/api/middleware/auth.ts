import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../../lib/config';

/**
 * API key authentication middleware.
 * Skipped automatically in dev mode (when API_KEY is not set).
 * Enabled by setting API_KEY in .env — all requests must then include
 * X-API-Key: <your-key> header.
 */
export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // No API_KEY configured = open access (local/dev mode)
  if (!config.API_KEY) return;

  const providedKey = request.headers['x-api-key'];

  if (!providedKey || providedKey !== config.API_KEY) {
    request.log.warn({ ip: request.ip, path: request.url }, 'Unauthorized API request');
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Provide a valid X-API-Key header.',
    });
  }
}
