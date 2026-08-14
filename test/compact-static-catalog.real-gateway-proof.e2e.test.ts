// Real-behavior proof for PR #123432: session compaction and PDF/image fallback
// runtime acquisition now use the static configured-model catalog. This file runs
// a real Gateway server (startGatewayWithClient) against a loopback mock OpenAI
// Responses provider, so it exercises the production gateway + prepared-runtime
// boundary with no prepared-model-runtime test harness.
//
// Run against the same immutable source at BEFORE_SHA and AFTER_SHA with
// PROOF_MODE=before|after. The static-vs-live catalog-mode observable is identical
// across both heads (the option already existed); the before/after caller-boundary
// difference is covered by the PR's call-shape tests. Markers are machine-readable.
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPreparedModelCatalogFull } from "../src/agents/prepared-model-runtime.facts.js";
import { acquireAgentRunPreparedModelRuntime } from "../src/agents/prepared-model-runtime.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../src/config/config.js";
import { clearSessionStoreCacheForTest } from "../src/config/sessions/store-writer-state.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
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
        const cfg = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
              },
            },
            entries: { main: { default: true } },
          },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          gateway: { auth: { mode: "token", token: "compact-static-proof-token" } },
        };

        // Scene 1 (control): before the Gateway lifecycle forces static mode, the
        // default live acquisition still builds the full catalog in the real process.
        const liveLease = await acquireAgentRunPreparedModelRuntime({
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
        const staticLease = await acquireAgentRunPreparedModelRuntime(
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
            (entry) => entry.provider === provider.providerId && entry.id === provider.modelId,
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
      } finally {
        envSnapshot.restore();
      }
    },
  );
});
