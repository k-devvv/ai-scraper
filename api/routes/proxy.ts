/**
 * api/routes/proxy.ts
 * Proxy pool management endpoints.
 *
 * GET  /v1/proxy/status  — view pool health
 * POST /v1/proxy/rotate  — force new Tor circuit (new IP)
 * POST /v1/proxy/add     — add a proxy to the pool at runtime
 * DELETE /v1/proxy       — remove a proxy from the pool
 */

import { FastifyInstance } from "fastify";
import { ProxyPool } from "../../src/lib/proxy-pool";
import { TorManager } from "../../src/lib/tor";

export async function proxyRoute(fastify: FastifyInstance): Promise<void> {

  // GET /v1/proxy/status
  fastify.get(
    "/v1/proxy/status",
    {
      schema: {
        description: "View proxy pool health — lists all proxies and Tor status",
        tags: ["system"],
        response: {
          200: {
            type: "object",
            properties: {
              total: { type: "integer" },
              healthy: { type: "integer" },
              tor: { type: "boolean" },
              torRunning: { type: "boolean" },
              torProxy: { type: "string" },
              proxies: { type: "array" },
            },
          },
        },
      },
    },
    async (_req, reply) => {
      const pool = ProxyPool.getInstance();
      const tor = TorManager.getInstance();
      const torRunning = await tor.isRunning();
      const status = pool.getStatus();

      return reply.send({
        ...status,
        torRunning,
        torProxy: torRunning ? tor.getSocksProxy() : null,
      });
    }
  );

  // POST /v1/proxy/rotate — request new Tor circuit
  fastify.post(
    "/v1/proxy/rotate",
    {
      schema: {
        description: "Request a new Tor circuit — rotates the exit node (changes IP)",
        tags: ["system"],
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              message: { type: "string" },
            },
          },
        },
      },
    },
    async (_req, reply) => {
      const tor = TorManager.getInstance();
      const running = await tor.isRunning();

      if (!running) {
        return (reply as any).code(503).send({
          success: false,
          message: "Tor is not running. Start with USE_TOR=true and ensure Tor is installed.",
        });
      }

      await tor.newCircuit();
      return reply.send({ success: true, message: "New Tor circuit requested — IP rotated" });
    }
  );

  // POST /v1/proxy/add — add proxy at runtime
  fastify.post<{ Body: { url: string } }>(
    "/v1/proxy/add",
    {
      schema: {
        description: "Add a proxy to the rotation pool at runtime",
        tags: ["system"],
        body: {
          type: "object",
          required: ["url"],
          properties: {
            url: {
              type: "string",
              description: "Proxy URL — http://user:pass@host:port or socks5://host:port",
            },
          },
        },
      },
    },
    async (req, reply) => {
      const { url } = req.body;

      try {
        new URL(url); // validate
      } catch {
        return reply.code(400).send({ error: "Invalid proxy URL" });
      }

      const pool = ProxyPool.getInstance();
      pool.addProxy(url);

      return reply.send({
        success: true,
        message: `Proxy added: ${url.replace(/:[^:@]+@/, ":***@")}`,
        status: pool.getStatus(),
      });
    }
  );

  // DELETE /v1/proxy — remove a proxy
  fastify.delete<{ Body: { url: string } }>(
    "/v1/proxy",
    {
      schema: {
        description: "Remove a proxy from the rotation pool",
        tags: ["system"],
        body: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const pool = ProxyPool.getInstance();
      pool.removeProxy(req.body.url);
      return reply.send({ success: true, status: pool.getStatus() });
    }
  );
}
