// Tests that force-clearing an embedded run persists terminal session state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { loadSessionEntry, upsertSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { abortAndDrainEmbeddedAgentRun, setActiveEmbeddedRun } from "./runs.js";
import { testing } from "./runs.test-support.js";

type RunHandle = Parameters<typeof setActiveEmbeddedRun>[1];

function createRunHandle(
  overrides: {
    abort?: () => void;
    isStreaming?: boolean;
  } = {},
): RunHandle {
  return {
    queueMessage: async () => {},
    isStreaming: () => overrides.isStreaming ?? true,
    isCompacting: () => false,
    abort: overrides.abort ?? (() => {}),
  };
}

describe("force-clear terminal state persistence", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-forceclear-"));
    storePath = path.join(tempDir, "sessions.json");
    setRuntimeConfigSnapshot({ session: { store: storePath } } as unknown as OpenClawConfig);
  });

  afterEach(async () => {
    clearRuntimeConfigSnapshot();
    testing.resetActiveEmbeddedRuns();
    replyRunTesting.resetReplyRunRegistry();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("persists killed status after a force-cleared run", async () => {
    const sessionKey = "agent:main:main";
    const sessionId = "session-1";
    const startedAt = Date.now() - 60_000;

    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionId,
        updatedAt: startedAt,
        startedAt,
        status: "running",
      },
    );

    setActiveEmbeddedRun(sessionId, createRunHandle(), sessionKey);

    const result = await abortAndDrainEmbeddedAgentRun({
      sessionId,
      sessionKey,
      forceClear: true,
      reason: "stuck_recovery",
      settleMs: 0,
    });

    expect(result.forceCleared).toBe(true);

    const entry = loadSessionEntry({ sessionKey, storePath });
    expect(entry?.status).toBe("killed");
    expect(entry?.abortedLastRun).toBe(true);
    expect(entry?.endedAt).toBeGreaterThanOrEqual(startedAt);
    expect(entry?.runtimeMs).toBeGreaterThan(0);
  });

  it("does not fail when the session entry is absent", async () => {
    const sessionKey = "agent:main:missing";
    const sessionId = "session-missing";

    setActiveEmbeddedRun(sessionId, createRunHandle(), sessionKey);

    const result = await abortAndDrainEmbeddedAgentRun({
      sessionId,
      sessionKey,
      forceClear: true,
      reason: "stuck_recovery",
      settleMs: 0,
    });

    expect(result.forceCleared).toBe(true);
  });

  it("does not persist state when sessionKey is omitted", async () => {
    const sessionId = "session-no-key";
    const sessionKey = "agent:main:no-key";

    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionId,
        updatedAt: Date.now(),
        status: "running",
      },
    );

    setActiveEmbeddedRun(sessionId, createRunHandle());

    const result = await abortAndDrainEmbeddedAgentRun({
      sessionId,
      forceClear: true,
      reason: "stuck_recovery",
      settleMs: 0,
    });

    expect(result.forceCleared).toBe(true);

    const entry = loadSessionEntry({ sessionKey, storePath });
    expect(entry?.status).toBe("running");
  });
});
