/**
 * Proof: credential redaction in Nextcloud Talk error response bodies.
 *
 * Verifies that reflected Authorization headers and generated HMAC signatures
 * are scrubbed from operator-visible send, reaction, and bot-preflight errors.
 *
 * Scenarios:
 *  1. Reflected Authorization → masked in send error
 *  2. Reflected HMAC signature → [redacted] in send error
 *  3. Truncated body (> 8 KiB) → snippet suppressed
 *  4. Reflected Authorization → masked in reaction error
 *  5. Reflected Authorization → masked in bot-preflight error
 *
 * BEFORE_SHA (main): tests 1-5 should FAIL (raw secrets visible).
 * AFTER_SHA  (PR):   tests 1-5 should PASS (secrets redacted).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── mock send.runtime.js ──────────────────────────────────────────────
const hoisted = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
  ssrfPolicyFromPrivateNetworkOptIn: vi.fn(() => undefined),
  generateNextcloudTalkSignature: vi.fn(() => ({
    random: "proof-random",
    signature: "proof-hmac-sig-8a7b3c9d",
  })),
  loadConfig: vi.fn(),
  resolveMarkdownTableMode: vi.fn(() => "preserve"),
  convertMarkdownTables: vi.fn((text: string) => text),
  record: vi.fn(),
  resolveNextcloudTalkAccount: vi.fn(),
}));

vi.mock("./send.runtime.js", () => ({
  convertMarkdownTables: hoisted.convertMarkdownTables,
  fetchWithSsrFGuard: hoisted.fetchWithSsrFGuard,
  generateNextcloudTalkSignature: hoisted.generateNextcloudTalkSignature,
  getNextcloudTalkRuntime: () => ({
    config: { loadConfig: hoisted.loadConfig },
    channel: {
      text: {
        resolveMarkdownTableMode: hoisted.resolveMarkdownTableMode,
        convertMarkdownTables: hoisted.convertMarkdownTables,
      },
      activity: { record: hoisted.record },
    },
  }),
  requireRuntimeConfig: (cfg: unknown) => cfg,
  resolveNextcloudTalkAccount: hoisted.resolveNextcloudTalkAccount,
  resolveMarkdownTableMode: hoisted.resolveMarkdownTableMode,
  ssrfPolicyFromPrivateNetworkOptIn: hoisted.ssrfPolicyFromPrivateNetworkOptIn,
}));

// ── mock runtime-api.js (for bot-preflight) ───────────────────────────
vi.mock("../runtime-api.js", () => ({
  fetchWithSsrFGuard: hoisted.fetchWithSsrFGuard,
}));

const { sendMessageNextcloudTalk, sendReactionNextcloudTalk } = await import("./send.js");
const { probeNextcloudTalkBotResponseFeature } = await import("./bot-preflight.js");

// ── helpers ────────────────────────────────────────────────────────────

const DEFAULT_ACCOUNT = {
  accountId: "default",
  baseUrl: "https://nc.example.com",
  secret: "bot-secret-123",
  secretSource: "config" as const,
  enabled: true,
  config: {
    baseUrl: "https://nc.example.com",
    botSecret: "bot-secret-123",
    apiUser: "admin",
    apiPassword: "app-password",
    webhookPublicUrl: "https://bot.example.com/nc-webhook",
  },
};

function mockFetchGuardError(body: string, status = 500): void {
  hoisted.fetchWithSsrFGuard.mockResolvedValueOnce({
    response: new Response(body, {
      status,
      headers: { "content-type": "text/plain" },
    }),
    release: async () => {},
    finalUrl: "https://nc.example.com/api/v1/bot/room/message",
  });
}

function mockFetchGuardErrorStream(body: string, status = 500): void {
  // Streaming body so readResponseTextPrefix can detect truncation.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  hoisted.fetchWithSsrFGuard.mockResolvedValueOnce({
    response: new Response(stream, {
      status,
      headers: { "content-type": "text/plain" },
    }),
    release: async () => {},
    finalUrl: "https://nc.example.com/api/v1/bot/room/message",
  });
}

beforeEach(() => {
  hoisted.resolveNextcloudTalkAccount.mockReturnValue(DEFAULT_ACCOUNT);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Credential that would appear in a reflected Authorization header.
const SECRET_CRED = "dGVzdDpwYXNzd29yZA==";

// ── Scenario 1: reflected Authorization in send error ──────────────────
describe("send error body redaction", () => {
  it("redacts reflected Authorization header from send failure", async () => {
    // A misbehaving upstream echoes the Authorization header in its error
    // body. The body includes "Authorization: Basic <cred>" which the
    // shared redactor (`redactToolPayloadText`) must mask.
    const rawBody = `Error: invalid request. Headers: { Authorization: Basic ${SECRET_CRED} }`;
    mockFetchGuardError(rawBody);

    const promise = sendMessageNextcloudTalk("room1", "hello", {
      cfg: {} as never,
      baseUrl: "https://nc.example.com",
      secret: "bot-secret-123",
    });

    await expect(promise).rejects.toThrow();
    try {
      await promise;
    } catch (err) {
      const msg = String(err);
      // The raw base64 credential must NOT appear verbatim.
      expect(msg).not.toContain(SECRET_CRED);
      // The redaction must have changed the output.
      expect(msg.length).toBeLessThan(`Error: Nextcloud Talk send failed: ${rawBody}`.length);
    }
  });

  it("redacts reflected HMAC signature from send failure", async () => {
    // Simulate upstream echoing X-Nextcloud-Talk-Bot-Signature in error body.
    const rawBody = `Bad signature: proof-hmac-sig-8a7b3c9d does not match`;
    mockFetchGuardError(rawBody);

    const promise = sendMessageNextcloudTalk("room1", "hello", {
      cfg: {} as never,
      baseUrl: "https://nc.example.com",
      secret: "bot-secret-123",
    });

    await expect(promise).rejects.toThrow();
    try {
      await promise;
    } catch (err) {
      const msg = String(err);
      // The raw HMAC must NOT appear verbatim.
      expect(msg).not.toMatch(/proof-hmac-sig-8a7b3c9d/);
      // The exact-value redaction uses "[redacted]".
      expect(msg).toContain("[redacted]");
    }
  });

  it("suppresses snippet when response body is truncated (> 8 KiB)", async () => {
    // A body larger than the 8 KiB read budget so the bounded reader
    // reports truncation. The PR must suppress the snippet entirely.
    const padding = "x".repeat(NEXTCLOUD_TALK_ERROR_SNIPPET_MAX_BYTES + 100);
    const rawBody = `${padding} proof-hmac-sig-8a7b3c9d`;
    mockFetchGuardErrorStream(rawBody);

    const promise = sendMessageNextcloudTalk("room1", "hello", {
      cfg: {} as never,
      baseUrl: "https://nc.example.com",
      secret: "bot-secret-123",
    });

    await expect(promise).rejects.toThrow();
    try {
      await promise;
    } catch (err) {
      const msg = String(err);
      // The HMAC should not appear — the snippet must be suppressed.
      expect(msg).not.toMatch(/proof-hmac-sig/);
      // The padding should not appear either (empty snippet).
      // Check that the error message doesn't include the streamed body prefix
      // (the collapsed snippet would show "xxx" if not suppressed).
      expect(msg).not.toMatch(/xxx/);
    }
  });
});

// ── Scenario 2: reflected Authorization in reaction error ─────────────
describe("reaction error body redaction", () => {
  it("redacts reflected Authorization header from reaction failure", async () => {
    // Use "Authorization:" prefix so the shared redactor pattern matches.
    const rawBody = `Error 500: bad request. Authorization: Basic ${SECRET_CRED}`;
    mockFetchGuardError(rawBody);

    const promise = sendReactionNextcloudTalk("room1", "msg1", "👍", {
      cfg: {} as never,
      baseUrl: "https://nc.example.com",
      secret: "bot-secret-123",
    });

    await expect(promise).rejects.toThrow();
    try {
      await promise;
    } catch (err) {
      const msg = String(err);
      expect(msg).not.toContain(SECRET_CRED);
      expect(msg.length).toBeLessThan(
        `Error: Nextcloud Talk reaction failed: 500 ${rawBody}`.trim().length,
      );
    }
  });
});

// ── Scenario 3: reflected Authorization in bot-preflight error ────────
describe("bot-preflight error body redaction", () => {
  it("redacts reflected Authorization header from preflight failure", async () => {
    // Use "Authorization:" prefix so the shared redactor pattern matches.
    const rawBody = `Upstream error: Authorization: Basic ${SECRET_CRED} was rejected`;
    hoisted.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: new Response(rawBody, {
        status: 502,
        headers: { "content-type": "text/plain" },
      }),
      release: async () => {},
      finalUrl: "https://nc.example.com/ocs/v2.php/apps/spreed/api/v1/bot/admin",
    });

    const result = await probeNextcloudTalkBotResponseFeature({
      account: {
        ...DEFAULT_ACCOUNT,
        accountId: "default",
        baseUrl: "https://nc.example.com",
        secret: "bot-secret-123",
        secretSource: "config" as const,
        enabled: true,
        config: {
          baseUrl: "https://nc.example.com",
          botSecret: "bot-secret-123",
          apiUser: "admin",
          apiPassword: "app-password",
          webhookPublicUrl: "https://bot.example.com/nc-webhook",
        },
      },
    });

    expect(result.ok).toBe(false);
    // The raw base64 credential must NOT appear.
    expect(result.message).not.toContain(SECRET_CRED);
    // The message must be shorter than if the credential were included raw.
    expect(result.message.length).toBeLessThan(
      `Nextcloud Talk bot response feature probe failed (502): ${rawBody}`.length,
    );
  });
});

// Import the constant for truncation test (duplicated locally so the test
// file doesn't depend on a non-exported module constant).
const NEXTCLOUD_TALK_ERROR_SNIPPET_MAX_BYTES = 8 * 1024;
