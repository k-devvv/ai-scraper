/**
 * api/routes/sessions.ts
 * Manage authenticated cookie sessions for social media scraping.
 *
 * POST   /v1/sessions/import     — import cookies from browser
 * GET    /v1/sessions            — list all sessions
 * GET    /v1/sessions/:platform  — list sessions for a platform
 * DELETE /v1/sessions/:platform/:id — delete a session
 * DELETE /v1/sessions/:platform     — delete all sessions for a platform
 */

import { FastifyInstance } from "fastify";
import {
  importSession,
  listSessions,
  deleteSession,
  clearSessions,
  PLATFORM_CONFIGS,
  type BrowserCookie,
} from "../../src/lib/session-store";

export async function sessionsRoute(fastify: FastifyInstance): Promise<void> {

  // POST /v1/sessions/import
  fastify.post<{
    Body: {
      platform: string;
      cookies: BrowserCookie[];
      label?: string;
    };
  }>(
    "/v1/sessions/import",
    {
      schema: {
        description:
          "Import browser cookies for authenticated scraping. " +
          "Export cookies from your browser using EditThisCookie or Cookie-Editor extension, " +
          "then paste the JSON array here.",
        tags: ["sessions"],
        body: {
          type: "object",
          required: ["platform", "cookies"],
          properties: {
            platform: {
              type: "string",
              enum: Object.keys(PLATFORM_CONFIGS),
              description: "Platform name: linkedin, instagram, facebook, twitter",
            },
            cookies: {
              type: "array",
              items: {
                type: "object",
                required: ["name", "value", "domain"],
                properties: {
                  name: { type: "string" },
                  value: { type: "string" },
                  domain: { type: "string" },
                  path: { type: "string", default: "/" },
                  expires: { type: "number" },
                  httpOnly: { type: "boolean" },
                  secure: { type: "boolean" },
                  sameSite: { type: "string", enum: ["Strict", "Lax", "None"] },
                },
              },
              description: "Array of cookies exported from your browser",
            },
            label: {
              type: "string",
              description: "Optional label (e.g. 'work account', 'personal')",
            },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const session = importSession(req.body.platform, req.body.cookies, req.body.label);
        return reply.code(201).send({
          success: true,
          sessionId: session.id,
          platform: session.platform,
          label: session.label,
          cookieCount: session.cookies.length,
          message: `Session imported. Use POST /v1/social/${session.platform} to scrape.`,
        });
      } catch (err) {
        return reply.code(400).send({
          error: "Import failed",
          message: (err as Error).message,
        });
      }
    }
  );

  // GET /v1/sessions
  fastify.get(
    "/v1/sessions",
    {
      schema: {
        description: "List all saved sessions across all platforms",
        tags: ["sessions"],
      },
    },
    async (_req, reply) => {
      const sessions = listSessions();
      return reply.send({
        total: sessions.length,
        sessions: sessions.map((s) => ({
          id: s.id,
          platform: s.platform,
          label: s.label,
          healthy: s.healthy,
          useCount: s.useCount,
          maxUsesPerDay: s.maxUsesPerDay,
          lastUsed: s.lastUsed ? new Date(s.lastUsed).toISOString() : null,
          createdAt: new Date(s.createdAt).toISOString(),
          cookieCount: s.cookies.length,
          // Never expose actual cookie values
        })),
      });
    }
  );

  // GET /v1/sessions/:platform
  fastify.get<{ Params: { platform: string } }>(
    "/v1/sessions/:platform",
    {
      schema: {
        description: "List sessions for a specific platform",
        tags: ["sessions"],
        params: {
          type: "object",
          properties: { platform: { type: "string" } },
          required: ["platform"],
        },
      },
    },
    async (req, reply) => {
      const sessions = listSessions(req.params.platform);
      return reply.send({
        platform: req.params.platform,
        total: sessions.length,
        sessions: sessions.map((s) => ({
          id: s.id,
          label: s.label,
          healthy: s.healthy,
          useCount: s.useCount,
          lastUsed: s.lastUsed ? new Date(s.lastUsed).toISOString() : null,
          cookieCount: s.cookies.length,
        })),
      });
    }
  );

  // DELETE /v1/sessions/:platform/:id
  fastify.delete<{ Params: { platform: string; id: string } }>(
    "/v1/sessions/:platform/:id",
    {
      schema: {
        description: "Delete a specific session",
        tags: ["sessions"],
        params: {
          type: "object",
          properties: {
            platform: { type: "string" },
            id: { type: "string" },
          },
          required: ["platform", "id"],
        },
      },
    },
    async (req, reply) => {
      const deleted = deleteSession(req.params.platform, req.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: "Session not found" });
      }
      return reply.code(204).send();
    }
  );

  // DELETE /v1/sessions/:platform — clear all for a platform
  fastify.delete<{ Params: { platform: string } }>(
    "/v1/sessions/:platform",
    {
      schema: {
        description: "Delete all sessions for a platform",
        tags: ["sessions"],
        params: {
          type: "object",
          properties: { platform: { type: "string" } },
          required: ["platform"],
        },
      },
    },
    async (req, reply) => {
      const count = clearSessions(req.params.platform);
      return reply.send({ deleted: count, platform: req.params.platform });
    }
  );
}
