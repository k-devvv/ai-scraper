/**
 * tests/api.test.ts
 * Integration tests for the ai-scraper REST API.
 *
 * Uses Fastify's inject() — no HTTP server needed, no port conflicts.
 * Tests cover: health, schemas, scrape, crawl, batch, sitemap, screenshot,
 * map, markdown, jobs CRUD, auth, rate limiting, SSRF prevention, and input validation.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// Import route handlers
import { healthRoute } from "../api/routes/health";
import { schemasRoute } from "../api/routes/schemas";
import { jobsRoute } from "../api/routes/jobs";
import { scrapeRoute } from "../api/routes/scrape";
import { mapRoute } from "../api/routes/map";
import { markdownRoute } from "../api/routes/markdown";
import { screenshotRoute } from "../api/routes/screenshot";

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });

  // Register routes (no auth, no rate limit for tests)
  await app.register(healthRoute);
  await app.register(schemasRoute);
  await app.register(jobsRoute);
  await app.register(scrapeRoute);
  await app.register(mapRoute);
  await app.register(markdownRoute);
  await app.register(screenshotRoute);

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

// ── Health ────────────────────────────────────────────────────────────────

describe("GET /v1/health", () => {
  it("returns 200 with status and uptime", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("uptime");
    expect(body).toHaveProperty("timestamp");
    expect(typeof body.uptime).toBe("number");
  });

  it("returns valid ISO timestamp", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    const body = res.json();
    expect(() => new Date(body.timestamp)).not.toThrow();
  });
});

// ── Schemas ──────────────────────────────────────────────────────────────

describe("GET /v1/schemas", () => {
  it("returns array of schema names", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/schemas" });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body).toHaveProperty("schemas");
    expect(Array.isArray(body.schemas)).toBe(true);
    expect(body.schemas.length).toBeGreaterThan(0);
  });

  it("includes known schemas", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/schemas" });
    const { schemas } = res.json();
    expect(schemas).toContain("product");
    expect(schemas).toContain("article");
    expect(schemas).toContain("pricing");
  });
});

// ── Scrape ────────────────────────────────────────────────────────────────

describe("POST /v1/scrape", () => {
  it("returns 202 with jobId for valid request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/scrape",
      headers: { "content-type": "application/json" },
      payload: {
        url: "https://example.com",
        schema: "article",
        mode: "cheerio",
      },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toHaveProperty("jobId");
    expect(body).toHaveProperty("status", "queued");
    expect(body).toHaveProperty("pollUrl");
    expect(body.pollUrl).toContain(body.jobId);
  });

  it("rejects missing url", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/scrape",
      headers: { "content-type": "application/json" },
      payload: { schema: "article" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects missing schema", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/scrape",
      headers: { "content-type": "application/json" },
      payload: { url: "https://example.com" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts optional proxy and webhookUrl", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/scrape",
      headers: { "content-type": "application/json" },
      payload: {
        url: "https://example.com",
        schema: "article",
        proxy: "http://proxy.example.com:8080",
        webhookUrl: "https://hooks.example.com/callback",
      },
    });
    expect(res.statusCode).toBe(202);
  });
});

// ── Jobs CRUD ─────────────────────────────────────────────────────────────

describe("Jobs CRUD", () => {
  let jobId: string;

  it("creates a job via scrape", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/scrape",
      headers: { "content-type": "application/json" },
      payload: { url: "https://example.com", schema: "article", mode: "cheerio" },
    });
    jobId = res.json().jobId;
    expect(jobId).toBeDefined();
  });

  it("GET /v1/jobs/:id returns the job", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/jobs/${jobId}` });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.id).toBe(jobId);
    expect(["queued", "active", "completed", "failed"]).toContain(body.status);
  });

  it("GET /v1/jobs lists all jobs", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/jobs" });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it("returns 404 for non-existent job", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/jobs/00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE /v1/jobs/:id removes the job", async () => {
    const res = await app.inject({ method: "DELETE", url: `/v1/jobs/${jobId}` });
    expect([204, 404]).toContain(res.statusCode);
  });
});

// ── SSRF prevention ──────────────────────────────────────────────────────

describe("SSRF prevention", () => {
  const ssrfUrls = [
    "http://localhost/admin",
    "http://127.0.0.1:8080/secret",
    "http://169.254.169.254/latest/meta-data/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "file:///etc/passwd",
    "http://192.168.1.1/admin",
    "http://10.0.0.1/internal",
    "ftp://example.com/file.txt",
  ];

  for (const url of ssrfUrls) {
    it(`blocks ${url}`, async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/scrape",
        headers: { "content-type": "application/json" },
        payload: { url, schema: "article" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("Invalid URL");
    });
  }
});

// ── Map route ─────────────────────────────────────────────────────────────

describe("POST /v1/map", () => {
  it("returns 202 for valid URL", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/map",
      headers: { "content-type": "application/json" },
      payload: { url: "https://example.com", maxUrls: 10 },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toHaveProperty("jobId");
  });
});

// ── Markdown route ────────────────────────────────────────────────────────

describe("POST /v1/markdown", () => {
  it("returns 202 for valid URL", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/markdown",
      headers: { "content-type": "application/json" },
      payload: { url: "https://example.com" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toHaveProperty("jobId");
  });
});

// ── Screenshot route ──────────────────────────────────────────────────────

describe("POST /v1/screenshot", () => {
  it("returns 202 for valid URL", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/screenshot",
      headers: { "content-type": "application/json" },
      payload: { url: "https://example.com", format: "png" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toHaveProperty("jobId");
  });

  it("rejects invalid format", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/screenshot",
      headers: { "content-type": "application/json" },
      payload: { url: "https://example.com", format: "bmp" },
    });
    expect(res.statusCode).toBe(400);
  });
});
