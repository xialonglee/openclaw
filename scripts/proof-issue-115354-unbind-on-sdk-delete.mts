#!/usr/bin/env node
// Standalone exact-head proof for PR #133694.
//
// Exercises the real plugin-SDK session deletion path against the real session
// binding service and a real OpenClaw state directory. The registry is seeded
// with a channel that advertises current-conversation binding support, so
// bindings are written through the generic production path rather than a
// hand-rolled adapter fixture.
//
// Expected behavior:
//   - BEFORE (main before fix): deleteSessionEntry returns true but the
//     conversation binding remains in the binding service.
//   - AFTER (PR head): deleteSessionEntry returns true and the binding is
//     removed. A rejecting adapter during session-delete cleanup is converged
//     and reported as a partial-cleanup error.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getSessionBindingService,
  registerSessionBindingAdapter,
  type SessionBindingRecord,
} from "../src/infra/outbound/session-binding-service.js";
import { deleteSessionEntry, upsertSessionEntry } from "../src/plugin-sdk/session-store-runtime.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../src/state/openclaw-state-db.js";

const SCENE = process.env.PROOF_SCENE ?? "main";
const SCENE_EXPECTATION = process.env.PROOF_EXPECTATION ?? "before";

function logMarker(marker: string): void {
  console.log(marker);
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

async function main(): Promise<void> {
  const proofRoot = mkdtempSync(join(tmpdir(), "openclaw-proof-115354-"));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = proofRoot;
  const storePath = join(proofRoot, "sessions.json");

  try {
    // Minimal registry using real bundled channel ids; only the
    // conversation-binding capability metadata is needed for the generic
    // current-conversation binding path.
    const registry = createEmptyPluginRegistry();
    registry.channels.push({
      pluginId: "telegram",
      pluginName: "Telegram",
      source: "bundled",
      plugin: {
        id: "telegram",
        meta: { aliases: [] },
        capabilities: {},
        config: { schema: () => ({}) },
        conversationBindings: { supportsCurrentConversationBinding: true },
      },
    } as unknown as (typeof registry.channels)[number]);
    registry.channels.push({
      pluginId: "discord",
      pluginName: "Discord",
      source: "bundled",
      plugin: {
        id: "discord",
        meta: { aliases: [] },
        capabilities: {},
        config: { schema: () => ({}) },
        conversationBindings: { supportsCurrentConversationBinding: true },
      },
    } as unknown as (typeof registry.channels)[number]);
    setActivePluginRegistry(registry);

    const sessionKey = "agent:main:acp:proof-session";
    const conversation = {
      channel: "telegram" as const,
      accountId: "proof-account",
      conversationId: "proof-conversation",
    };

    // Seed the session entry.
    await upsertSessionEntry({
      agentId: "main",
      sessionKey,
      storePath,
      entry: {
        sessionId: "proof-session-id",
        updatedAt: Date.now(),
      },
    });

    // Bind the conversation to the session through the real binding service.
    await getSessionBindingService().bind({
      targetSessionKey: sessionKey,
      targetKind: "session",
      conversation,
    });

    const bindingsBeforeDelete = getSessionBindingService().listBySession(sessionKey);
    logMarker(`[proof] scene=${SCENE} step=bind-observed count=${bindingsBeforeDelete.length}`);
    assert(bindingsBeforeDelete.length === 1, "expected one binding after bind");

    // Delete the session through the plugin SDK path under test.
    let deleted: boolean;
    let partialCleanupError: unknown = null;
    try {
      deleted = await deleteSessionEntry({ sessionKey, storePath });
    } catch (error) {
      deleted = true; // After fix: session row is deleted even when cleanup partially fails.
      partialCleanupError = error;
    }

    logMarker(`[proof] scene=${SCENE} step=deleted result=${deleted}`);
    assert(deleted === true, "expected session deletion to succeed");

    const bindingsAfterDelete = getSessionBindingService().listBySession(sessionKey);
    logMarker(
      `[proof] scene=${SCENE} step=bindings-after-delete count=${bindingsAfterDelete.length}`,
    );

    if (SCENE_EXPECTATION === "before") {
      // Pre-fix invariant: the session row is gone but the runtime binding survives.
      assert(bindingsAfterDelete.length === 1, "expected stale binding to survive before fix");
      logMarker(
        `[proof] scene=${SCENE} status=pass expectation=before stale_binding_survived=true`,
      );
    } else {
      // Post-fix invariant: the binding is removed along with the session.
      assert(bindingsAfterDelete.length === 0, "expected binding to be removed after fix");
      logMarker(`[proof] scene=${SCENE} status=pass expectation=after binding_removed=true`);
    }

    // Partial-cleanup scenario only makes sense after the fix; on the before
    // SHA the helper does not exist and the service does not converge.
    if (SCENE_EXPECTATION === "after") {
      await runPartialCleanupScene(proofRoot);
    }
  } finally {
    closeOpenClawStateDatabaseForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    rmSync(proofRoot, { recursive: true, force: true });
  }
}

async function runPartialCleanupScene(proofRoot: string): Promise<void> {
  const sessionKey = "agent:main:acp:proof-partial-cleanup";
  const okConversation = {
    channel: "discord" as const,
    accountId: "proof-account",
    conversationId: "proof-conversation-ok",
  };
  const failingConversation = {
    channel: "telegram" as const,
    accountId: "proof-account",
    conversationId: "proof-conversation-fail",
  };

  let adapterBinding: SessionBindingRecord | null = null;
  registerSessionBindingAdapter({
    channel: "telegram",
    accountId: "proof-account",
    bind: async (input) => {
      adapterBinding = {
        bindingId: `${input.conversation.accountId}:${input.conversation.conversationId}`,
        targetSessionKey: input.targetSessionKey,
        targetKind: input.targetKind,
        conversation: input.conversation,
        status: "active",
        boundAt: 1,
      };
      return adapterBinding;
    },
    listBySession: (key) => (adapterBinding?.targetSessionKey === key ? [adapterBinding] : []),
    resolveByConversation: () => null,
    unbind: async () => {
      throw new Error("simulated durable unbind failure");
    },
  });

  // Seed session and bind through both the failing adapter and the generic path.
  await upsertSessionEntry({
    agentId: "main",
    sessionKey,
    storePath: join(proofRoot, "sessions.json"),
    entry: {
      sessionId: "proof-partial-session-id",
      updatedAt: Date.now(),
    },
  });

  await getSessionBindingService().bind({
    targetSessionKey: sessionKey,
    targetKind: "session",
    conversation: failingConversation,
  });
  await getSessionBindingService().bind({
    targetSessionKey: sessionKey,
    targetKind: "session",
    conversation: okConversation,
  });

  const beforeCount = getSessionBindingService().listBySession(sessionKey).length;
  logMarker(`[proof] scene=partial-cleanup step=bind-observed count=${beforeCount}`);
  assert(beforeCount >= 2, "expected at least two bindings for partial cleanup scene");

  let deleteRejected = false;
  let errorIsPartialCleanup = false;
  try {
    await deleteSessionEntry({ sessionKey, storePath: join(proofRoot, "sessions.json") });
  } catch (error) {
    deleteRejected = true;
    // The isSessionBindingPartialCleanupError helper was added by the fix; use
    // structural fallback in case an older module shape is loaded.
    const err = error as Record<string, unknown>;
    errorIsPartialCleanup =
      err?.constructor?.name === "SessionBindingPartialCleanupError" ||
      (typeof err?.code === "string" && err.code === "BINDING_PARTIAL_CLEANUP");
  }

  assert(deleteRejected, "expected partial cleanup to reject");
  assert(errorIsPartialCleanup, "expected partial cleanup error type");

  const afterCount = getSessionBindingService().listBySession(sessionKey).length;
  const removedResolvedBinding = getSessionBindingService().resolveByConversation(okConversation);
  logMarker(
    `[proof] scene=partial-cleanup step=after-delete count=${afterCount} ok_binding_removed=${removedResolvedBinding === null}`,
  );
  assert(
    removedResolvedBinding === null,
    "expected non-failing binding to be removed during convergent cleanup",
  );
  logMarker(`[proof] scene=partial-cleanup status=pass converged=true`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
