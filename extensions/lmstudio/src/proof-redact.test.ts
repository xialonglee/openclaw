// Proof: LM Studio model load error body credential redaction.
// BEFORE_SHA: raw credentials leak into error message (bug).
// AFTER_SHA:  credentials are redacted by redactToolPayloadText (fix).
import { describe, expect, it, vi } from "vitest";
import { ensureLmstudioModelLoaded } from "./models.fetch.js";

// ── helpers ────────────────────────────────────────────────────────────

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const PROOF_MODE = (process.env.PROOF_MODE ?? "before") as "before" | "after";

// ── proof scenes ───────────────────────────────────────────────────────

describe("proof: LM Studio error body credential redaction", () => {
  it("redacts Bearer tokens from upstream error response body", async () => {
    const secretToken = "sk-test-token-abc123";
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/api/v1/models")) {
        return jsonResponse({
          models: [{ type: "llm", key: "qwen3-8b-instruct", loaded_instances: [] }],
        });
      }
      if (String(url).endsWith("/api/v1/models/load")) {
        return new Response(
          JSON.stringify({
            error: `Authorization: Bearer ${secretToken}`,
          }),
          { status: 503 },
        );
      }
      throw new Error(`Unexpected fetch URL: ${String(url)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await ensureLmstudioModelLoaded({
      baseUrl: "http://localhost:1234/v1",
      modelKey: "qwen3-8b-instruct",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/LM Studio model load failed \(503\)/);

    if (PROOF_MODE === "before") {
      expect(message).toContain(secretToken);
    } else {
      expect(message).not.toContain(secretToken);
      expect(message).toContain("Authorization");
    }
  });

  it("redacts api keys in plaintext error bodies", async () => {
    const secretToken = "sk-secret-api-key-xyz789";
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/api/v1/models")) {
        return jsonResponse({
          models: [{ type: "llm", key: "qwen3-8b-instruct", loaded_instances: [] }],
        });
      }
      if (String(url).endsWith("/api/v1/models/load")) {
        return new Response(`Server error: Authorization: Bearer ${secretToken}`, { status: 500 });
      }
      throw new Error(`Unexpected fetch URL: ${String(url)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await ensureLmstudioModelLoaded({
      baseUrl: "http://localhost:1234/v1",
      modelKey: "qwen3-8b-instruct",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/LM Studio model load failed \(500\)/);

    if (PROOF_MODE === "before") {
      expect(message).toContain(secretToken);
    } else {
      expect(message).not.toContain(secretToken);
      expect(message).toContain("Server error");
    }
  });

  it("preserves non-sensitive diagnostic text in error bodies", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/api/v1/models")) {
        return jsonResponse({
          models: [{ type: "llm", key: "qwen3-8b-instruct", loaded_instances: [] }],
        });
      }
      if (String(url).endsWith("/api/v1/models/load")) {
        return new Response("GPU out of memory", { status: 500 });
      }
      throw new Error(`Unexpected fetch URL: ${String(url)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await ensureLmstudioModelLoaded({
      baseUrl: "http://localhost:1234/v1",
      modelKey: "qwen3-8b-instruct",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("GPU out of memory");
  });
});
