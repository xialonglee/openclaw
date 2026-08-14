// Real-behavior proof for PR #123432: session compaction and PDF/image fallback
// runtime acquisition now use the static configured-model catalog. This file runs
// a real Gateway server (startGatewayWithClient) against a loopback mock OpenAI
// Responses provider, so it exercises the production gateway + prepared-runtime
// boundary with no prepared-model-runtime test harness.
//
// Run against the same immutable source at BEFORE_SHA and AFTER_SHA with
// PROOF_MODE=before|after. The compact-direct and image-fallback scenes spy
// (call-through) on acquireAgentRunPreparedModelRuntime so the caller's exact
// catalogMode argument is recorded at each head: the changed callers pass
// catalogMode "static" only at AFTER_SHA. Markers are machine-readable.
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compactEmbeddedAgentSessionDirect } from "../src/agents/embedded-agent-runner/compact.js";
import { isPreparedModelCatalogFull } from "../src/agents/prepared-model-runtime.facts.js";
import * as preparedRuntime from "../src/agents/prepared-model-runtime.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../src/config/config.js";
import { clearSessionStoreCacheForTest } from "../src/config/sessions/store-writer-state.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { resolveImageRuntime } from "../src/media-understanding/image-model-runtime.js";
import { captureEnv, setTestEnvValue } from "../src/test-utils/env.js";

const PROOF_MODE = process.env.PROOF_MODE?.trim() || "before";

const envKeys = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

function emitMarker(marker: string): void {
  console.log(`[proof] ${marker}`);
}

type CapturedAcquisition = {
  catalogMode: string | undefined;
  fullCatalog: boolean | undefined;
};

/**
 * Call-through spy on the prepared-runtime acquisition boundary. Records the
 * catalogMode argument each caller passes and whether the acquired snapshot is a
 * full catalog, while the real production function still runs.
 */
function installAcquisitionSpy(): {
  spy: ReturnType<typeof vi.spyOn>;
  captured: CapturedAcquisition[];
} {
  const captured: CapturedAcquisition[] = [];
  const original = preparedRuntime.acquireAgentRunPreparedModelRuntime;
  const spy = vi.spyOn(preparedRuntime, "acquireAgentRunPreparedModelRuntime");
  spy.mockImplementation(async (...args: Parameters<typeof original>) => {
    const lease = await original(...args);
    captured.push({
      catalogMode: args[1]?.catalogMode,
      fullCatalog: isPreparedModelCatalogFull(lease.snapshot.modelCatalog),
    });
    return lease;
  });
  return { spy, captured };
}

function summarizeCatalogModes(captures: readonly CapturedAcquisition[]): string {
  return captures.map((entry) => entry.catalogMode ?? "none").join(",") || "no-calls";
}

function buildResponsesSse(text: string): string {
  const message = {
    type: "message",
    id: "compact-static-catalog-proof-message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        status: "completed",
        usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
      },
    },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .concat("data: [DONE]\n\n")
    .join("");
}

describe("proof: real gateway compaction/media static catalog", () => {
  let tempHome: string | undefined;
  let providerServer: Server | undefined;
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;

  afterEach(async () => {
    if (gateway) {
      await disconnectGatewayClient(gateway.client).catch(() => undefined);
      await gateway.server.close().catch(() => undefined);
      gateway = undefined;
    }
    if (providerServer?.listening) {
      await new Promise<void>((resolve) => providerServer?.close(() => resolve()));
    }
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true }).catch(() => undefined);
      tempHome = undefined;
    }
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();
  });

  it(
    "serves a configured model call and keeps static acquisition full-catalog-free",
    { timeout: 120_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);

      try {
        tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compact-static-proof-"));
        const stateDir = path.join(tempHome, ".openclaw");
        const workspaceDir = path.join(tempHome, "workspace");
        const configPath = path.join(stateDir, "openclaw.json");
        const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
        await Promise.all([
          fs.mkdir(workspaceDir, { recursive: true }),
          fs.mkdir(bundledPluginsDir, { recursive: true }),
          fs.mkdir(path.dirname(configPath), { recursive: true }),
        ]);
        for (const [key, value] of Object.entries({
          HOME: tempHome,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_TOKEN: "compact-static-proof-token",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        })) {
          setTestEnvValue(key, value);
        }

        providerServer = createServer((_request, response) => {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(buildResponsesSse("COMPACT_STATIC_CATALOG_PROOF_OK"));
        });
        await new Promise<void>((resolve, reject) => {
          providerServer?.once("error", reject);
          providerServer?.listen(0, "127.0.0.1", resolve);
        });
        const providerAddress = providerServer.address();
        if (!providerAddress || typeof providerAddress === "string") {
          throw new Error("proof provider did not bind a loopback port");
        }
        const provider = buildMockOpenAiResponsesProvider(
          `http://127.0.0.1:${providerAddress.port}/v1`,
        );
        // Make the configured model image-capable so the image fallback scene can
        // resolve it through the committed Gateway owner.
        const imageCapableConfig = {
          ...provider.config,
          models: [
            { ...provider.config.models[0], input: ["text", "image"] },
          ] as typeof provider.config.models,
        };
        const imageProvider = { ...provider, config: imageCapableConfig };
        const cfg = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              model: { primary: imageProvider.modelRef },
              models: {
                [imageProvider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
              },
            },
            entries: { main: { default: true } },
          },
          models: {
            mode: "replace",
            providers: { [imageProvider.providerId]: imageProvider.config },
          },
          gateway: { auth: { mode: "token", token: "compact-static-proof-token" } },
        };

        // Scene 1 (control): before the Gateway lifecycle forces static mode, the
        // default live acquisition still builds the full catalog in the real process.
        const liveLease = await preparedRuntime.acquireAgentRunPreparedModelRuntime({
          agentDir: path.join(tempHome, "proof-live-agent"),
          workspaceDir,
          config: cfg,
        });
        let liveFullCatalog: boolean | undefined;
        try {
          liveFullCatalog = isPreparedModelCatalogFull(liveLease.snapshot.modelCatalog);
        } finally {
          liveLease.release();
        }
        const livePass = liveFullCatalog === true;
        emitMarker(
          `scene=live-acquire mode=${PROOF_MODE} status=${livePass ? "pass" : "fail"} full_catalog=${liveFullCatalog}`,
        );
        expect(liveFullCatalog).toBe(true);

        // Scene 2: a real Gateway serves a configured model call.
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token: "compact-static-proof-token",
          clientDisplayName: "compact-static-proof",
        });
        const sessionKey = "agent:main:compact-static-proof";
        const started = await gateway.client.request<{ runId?: string; status?: string }>(
          "chat.send",
          {
            sessionKey,
            message: "reply with the proof marker",
            deliver: false,
            idempotencyKey: "compact-static-proof-turn",
          },
        );
        const waitResult = await gateway.client.request(
          "agent.wait",
          { runId: started.runId, timeoutMs: 45_000 },
          { timeoutMs: 50_000 },
        );
        const modelCallSucceeded =
          started.status === "started" && started.runId !== undefined && waitResult.status === "ok";
        emitMarker(
          `scene=gateway-call mode=${PROOF_MODE} status=${modelCallSucceeded ? "pass" : "fail"} run_started=${started.status === "started"} run_wait=${waitResult.status}`,
        );
        expect(started.status).toBe("started");
        expect(waitResult.status).toBe("ok");

        // Scene 3: the static acquisition used by compaction/media fallback resolves
        // the configured model and skips the full catalog build.
        const staticLease = await preparedRuntime.acquireAgentRunPreparedModelRuntime(
          {
            agentId: "main",
            agentDir: path.join(stateDir, "agents", "main"),
            workspaceDir,
            config: cfg,
          },
          { catalogMode: "static" },
        );
        let staticFullCatalog: boolean | undefined;
        let staticConfiguredResolved = false;
        try {
          const snapshot = staticLease.snapshot;
          staticFullCatalog = isPreparedModelCatalogFull(snapshot.modelCatalog);
          staticConfiguredResolved = (snapshot.inlineProviderModels ?? []).some(
            (entry) =>
              entry.provider === imageProvider.providerId && entry.id === imageProvider.modelId,
          );
        } finally {
          staticLease.release();
        }
        const staticPass = staticConfiguredResolved && staticFullCatalog === false;
        emitMarker(
          `scene=static-acquire mode=${PROOF_MODE} status=${staticPass ? "pass" : "fail"} configured_resolved=${staticConfiguredResolved} full_catalog=${staticFullCatalog}`,
        );
        expect(staticConfiguredResolved).toBe(true);
        expect(staticFullCatalog).toBe(false);

        // Scene 4: direct compaction through the changed production boundary. The
        // session from Scene 2 exists, so the compaction caller resolves it and then
        // acquires its prepared runtime; the spy records the exact catalogMode the
        // caller passes at this head.
        const { spy: compactSpy, captured: compactCaptures } = installAcquisitionSpy();
        let compactResult: { ok?: boolean; compacted?: boolean; reason?: string } | undefined;
        try {
          compactResult = await compactEmbeddedAgentSessionDirect({
            sessionKey,
            sessionId: "",
            agentId: "main",
            agentDir: path.join(stateDir, "agents", "main"),
            workspaceDir,
            config: cfg,
            trigger: "manual",
            provider: imageProvider.providerId,
            model: imageProvider.modelId,
          });
        } finally {
          compactSpy.mockRestore();
        }
        const compactStaticCall = compactCaptures.find((entry) => entry.catalogMode === "static");
        const compactPass =
          PROOF_MODE === "after"
            ? compactStaticCall !== undefined && compactStaticCall.fullCatalog === false
            : compactCaptures.length > 0 &&
              !compactCaptures.some((entry) => entry.catalogMode === "static");
        emitMarker(
          `scene=compact-direct mode=${PROOF_MODE} status=${compactPass ? "pass" : "fail"} catalog_modes=${summarizeCatalogModes(compactCaptures)} static_full_catalog=${compactStaticCall?.fullCatalog ?? "n/a"} compact_ok=${compactResult?.ok ?? "n/a"} compacted=${compactResult?.compacted ?? "n/a"} reason=${compactResult?.reason ?? "none"}`,
        );
        expect(compactPass).toBe(true);

        // Scene 5: image fallback through the changed production boundary. The
        // configured mock model is image-capable, so resolveImageRuntime runs through
        // its prepared-runtime acquisition and model resolution with the real Gateway.
        const { spy: imageSpy, captured: imageCaptures } = installAcquisitionSpy();
        let imageResolved = false;
        let imageError: string | undefined;
        try {
          const resolvedImage = await resolveImageRuntime({
            cfg,
            agentDir: path.join(stateDir, "agents", "main"),
            agentId: "main",
            workspaceDir,
            provider: imageProvider.providerId,
            model: imageProvider.modelId,
          });
          imageResolved = resolvedImage.model !== undefined;
          resolvedImage.release?.();
        } catch (error) {
          imageError = String(error);
        } finally {
          imageSpy.mockRestore();
        }
        const imageStaticCall = imageCaptures.find((entry) => entry.catalogMode === "static");
        const imagePass =
          PROOF_MODE === "after"
            ? imageStaticCall !== undefined && imageStaticCall.fullCatalog === false
            : imageCaptures.length > 0 &&
              !imageCaptures.some((entry) => entry.catalogMode === "static");
        emitMarker(
          `scene=image-fallback mode=${PROOF_MODE} status=${imagePass ? "pass" : "fail"} catalog_modes=${summarizeCatalogModes(imageCaptures)} static_full_catalog=${imageStaticCall?.fullCatalog ?? "n/a"} resolved=${imageResolved} error=${imageError ?? "none"}`,
        );
        expect(imagePass).toBe(true);
      } finally {
        envSnapshot.restore();
      }
    },
  );
});
