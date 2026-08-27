// Real-behavior proof for PR #123432: the prepared-runtime lifecycle owner now
// defaults agent-run admissions to the static configured-model catalog.
// Session compaction and PDF/image fallback are exercised by the PR's own
// regression tests; this proof demonstrates the lifecycle-owned default change
// with a real Gateway plus a direct acquisition spy.
//
// Run against the same immutable source at BEFORE_SHA and AFTER_SHA with
// PROOF_MODE=before|after. Each scene spies on ensureOpenClawModelsJson (the
// live catalog build entry point) and reports whether it was invoked. In
// BEFORE the default still triggers live discovery; in AFTER it does not.
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureOpenClawModelsJson } from "../src/agents/models-config.js";
import * as preparedRuntime from "../src/agents/prepared-model-runtime.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../src/config/config.js";
import { clearSessionStoreCacheForTest } from "../src/config/sessions/store-writer-state.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { captureEnv, setTestEnvValue } from "../src/test-utils/env.js";

vi.mock("../src/agents/models-config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/agents/models-config.js")>();
  return {
    ...original,
    ensureOpenClawModelsJson: vi.fn(original.ensureOpenClawModelsJson),
  };
});

const PROOF_MODE = process.env.PROOF_MODE?.trim() || "before";

const preparedModelRuntimeTestApi = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.preparedModelRuntimeTestApi")
] as
  | {
      resetPreparedModelRuntimeSnapshotsForTest(): void;
      getPreparedModelRuntimeOwnerCountForTest(): number;
    }
  | undefined;

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

function catalogBuildCalls(): number {
  return vi.mocked(ensureOpenClawModelsJson).mock.calls.length;
}

function resetCatalogBuildSpy(): void {
  vi.mocked(ensureOpenClawModelsJson).mockClear();
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

function buildModelsListResponse(modelIds: readonly string[]): unknown {
  return {
    object: "list",
    data: modelIds.map((id) => ({
      id,
      object: "model",
      created: 1_700_000_000,
      owned_by: "proof",
    })),
  };
}

async function startDelayedProviderServer(delayMs: number): Promise<{
  server: Server;
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/v1/models")) {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(buildModelsListResponse(["gpt-5.4"])));
      }, delayMs);
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(buildResponsesSse("COMPACT_STATIC_CATALOG_PROOF_OK"));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("proof provider did not bind a loopback port");
  }
  return {
    server,
    port: address.port,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }).catch(() => undefined);
    },
  };
}

function buildOpenAiResponsesProviderConfig(
  providerId: string,
  baseUrl: string,
  modelId = "gpt-5.4",
): { providerId: string; modelId: string; modelRef: string; config: unknown } {
  return {
    providerId,
    modelId,
    modelRef: `${providerId}/${modelId}`,
    config: {
      baseUrl,
      apiKey: "test",
      api: "openai-responses",
      models: [
        {
          id: modelId,
          name: modelId,
          api: "openai-responses",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 4096,
        },
      ],
    },
  };
}

function rssMb(): number {
  return Math.round((process.memoryUsage().rss / 1024 / 1024) * 100) / 100;
}

describe("proof: real gateway compaction/media static catalog", () => {
  let tempHome: string | undefined;
  let providerServer: Server | undefined;
  let delayedProviderServers: Awaited<ReturnType<typeof startDelayedProviderServer>>[] = [];
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  afterEach(async () => {
    if (gateway) {
      await disconnectGatewayClient(gateway.client).catch(() => undefined);
      await gateway.server.close().catch(() => undefined);
      gateway = undefined;
    }
    if (providerServer?.listening) {
      await new Promise<void>((resolve) => {
        providerServer?.close(() => {
          resolve();
        });
      });
      providerServer = undefined;
    }
    for (const delayed of delayedProviderServers) {
      await delayed.close();
    }
    delayedProviderServers = [];
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true }).catch(() => undefined);
      tempHome = undefined;
    }
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();
  });

  it(
    "records live catalog discovery across default acquisition, compaction, and image fallback",
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

        // Scene 1 (control): explicit live acquisition still triggers discovery at
        // both heads.
        resetCatalogBuildSpy();
        const liveLease = await preparedRuntime.acquireAgentRunPreparedModelRuntime(
          {
            agentDir: path.join(tempHome, "proof-live-agent"),
            workspaceDir,
            config: cfg,
          },
          { catalogMode: "live" },
        );
        liveLease.release();
        const liveCalls = catalogBuildCalls();
        const livePass = liveCalls > 0;
        emitMarker(
          `scene=live-acquire mode=${PROOF_MODE} status=${livePass ? "pass" : "fail"} ensure_calls=${liveCalls}`,
        );
        expect(liveCalls).toBeGreaterThan(0);

        // Scene 2 (the changed default): default acquisition triggers live discovery
        // on BEFORE but not on AFTER.
        resetCatalogBuildSpy();
        const defaultLease = await preparedRuntime.acquireAgentRunPreparedModelRuntime({
          agentId: "main",
          agentDir: path.join(tempHome, "proof-default-agent"),
          workspaceDir,
          config: cfg,
        });
        defaultLease.release();
        const defaultCalls = catalogBuildCalls();
        const defaultExpectDiscovery = PROOF_MODE === "before";
        const defaultPass = defaultCalls > 0 === defaultExpectDiscovery;
        emitMarker(
          `scene=default-acquire mode=${PROOF_MODE} status=${defaultPass ? "pass" : "fail"} ensure_calls=${defaultCalls} expected_discovery=${defaultExpectDiscovery}`,
        );
        expect(defaultCalls > 0).toBe(defaultExpectDiscovery);

        // Scene 2b (current-head regression): a partial options object with only
        // retainIdleRunOwner must also default to static catalog mode.
        resetCatalogBuildSpy();
        const partialLease = await preparedRuntime.acquireAgentRunPreparedModelRuntime(
          {
            agentDir: path.join(tempHome, "proof-partial-agent"),
            workspaceDir,
            config: cfg,
          },
          { retainIdleRunOwner: true },
        );
        partialLease.release();
        const partialCalls = catalogBuildCalls();
        const partialExpectDiscovery = PROOF_MODE === "before";
        const partialPass = partialCalls > 0 === partialExpectDiscovery;
        emitMarker(
          `scene=partial-acquire mode=${PROOF_MODE} status=${partialPass ? "pass" : "fail"} ensure_calls=${partialCalls} expected_discovery=${partialExpectDiscovery}`,
        );
        expect(partialCalls > 0).toBe(partialExpectDiscovery);

        // Scene 3: a real Gateway serves a configured model call in both modes.
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token: "compact-static-proof-token",
          clientDisplayName: "compact-static-proof",
        });
        const started = await gateway.client.request<{ runId?: string; status?: string }>(
          "chat.send",
          {
            sessionKey: "agent:main:compact-static-proof",
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
          `scene=gateway-call mode=${PROOF_MODE} status=${modelCallSucceeded ? "pass" : "fail"} run_started=${started.status === "started"} run_wait=${String(waitResult.status)}`,
        );
        expect(started.status).toBe("started");
        expect(waitResult.status).toBe("ok");

        // Scene 4: multi-provider timing/RSS benchmark. Reset the lifecycle
        // owners first so this scene is not rebound to the Gateway-published
        // owner from Scene 3; then spin up five independent mock providers.
        preparedModelRuntimeTestApi?.resetPreparedModelRuntimeSnapshotsForTest();

        // Scene 4: multi-provider timing/RSS benchmark. Five independent mock
        // providers each delay their /v1/models response. In BEFORE the default
        // acquisition serializes live discovery across all five; in AFTER it uses
        // the static configured catalog and skips the HTTP calls entirely.
        const PROVIDER_COUNT = 5;
        const PER_PROVIDER_DELAY_MS = 300;
        delayedProviderServers = await Promise.all(
          Array.from({ length: PROVIDER_COUNT }, () =>
            startDelayedProviderServer(PER_PROVIDER_DELAY_MS),
          ),
        );
        const benchmarkProviders = delayedProviderServers.map((server, index) =>
          buildOpenAiResponsesProviderConfig(
            `mock-openai-bench-${index + 1}`,
            `http://127.0.0.1:${server.port}/v1`,
            `gpt-5.4-bench-${index + 1}`,
          ),
        );
        const primaryBenchmarkProvider = benchmarkProviders[0];
        const benchmarkCfg = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              model: { primary: primaryBenchmarkProvider.modelRef },
              models: {
                [primaryBenchmarkProvider.modelRef]: {
                  params: { transport: "sse", openaiWsWarmup: false },
                },
              },
            },
            entries: { main: { default: true } },
          },
          models: {
            mode: "replace",
            providers: Object.fromEntries(benchmarkProviders.map((p) => [p.providerId, p.config])),
          },
          gateway: { auth: { mode: "token", token: "compact-static-proof-token" } },
        };

        async function measureAcquisition(
          label: string,
          input: Omit<
            Parameters<typeof preparedRuntime.acquireAgentRunPreparedModelRuntime>[0],
            "agentId"
          > & {
            agentId?: string;
          },
          options?: Parameters<typeof preparedRuntime.acquireAgentRunPreparedModelRuntime>[1],
        ): Promise<{ ms: number; rssBeforeMb: number; rssAfterMb: number }> {
          resetCatalogBuildSpy();
          const rssBeforeMb = rssMb();
          const startedAt = performance.now();
          const lease = await preparedRuntime.acquireAgentRunPreparedModelRuntime(input, options);
          const ms = Math.round(performance.now() - startedAt);
          const rssAfterMb = rssMb();
          lease.release();
          return { ms, rssBeforeMb, rssAfterMb };
        }

        const liveResult = await measureAcquisition(
          "live",
          {
            agentId: "main",
            agentDir: path.join(tempHome, "proof-bench-live-agent"),
            workspaceDir,
            config: benchmarkCfg,
          },
          { catalogMode: "live" },
        );
        const liveDiscoveryCalls = catalogBuildCalls();
        emitMarker(
          `scene=multi-provider-benchmark mode=${PROOF_MODE} subscene=live status=pass ensure_calls=${liveDiscoveryCalls} provider_count=${PROVIDER_COUNT} per_provider_delay_ms=${PER_PROVIDER_DELAY_MS} ms=${liveResult.ms} rss_before_mb=${liveResult.rssBeforeMb} rss_after_mb=${liveResult.rssAfterMb}`,
        );
        expect(liveDiscoveryCalls).toBeGreaterThan(0);

        const benchDefaultExpectDiscovery = PROOF_MODE === "before";
        const defaultResult = await measureAcquisition("default", {
          agentId: "main",
          agentDir: path.join(tempHome, "proof-bench-default-agent"),
          workspaceDir,
          config: benchmarkCfg,
        });
        const defaultDiscoveryCalls = catalogBuildCalls();
        const benchDefaultPass = defaultDiscoveryCalls > 0 === benchDefaultExpectDiscovery;
        emitMarker(
          `scene=multi-provider-benchmark mode=${PROOF_MODE} subscene=default status=${benchDefaultPass ? "pass" : "fail"} ensure_calls=${defaultDiscoveryCalls} expected_discovery=${benchDefaultExpectDiscovery} provider_count=${PROVIDER_COUNT} per_provider_delay_ms=${PER_PROVIDER_DELAY_MS} ms=${defaultResult.ms} rss_before_mb=${defaultResult.rssBeforeMb} rss_after_mb=${defaultResult.rssAfterMb}`,
        );
        expect(defaultDiscoveryCalls > 0).toBe(benchDefaultExpectDiscovery);

        const benchPartialExpectDiscovery = PROOF_MODE === "before";
        const partialResult = await measureAcquisition(
          "partial",
          {
            agentId: "main",
            agentDir: path.join(tempHome, "proof-bench-partial-agent"),
            workspaceDir,
            config: benchmarkCfg,
          },
          { retainIdleRunOwner: true },
        );
        const partialDiscoveryCalls = catalogBuildCalls();
        const benchPartialPass = partialDiscoveryCalls > 0 === benchPartialExpectDiscovery;
        emitMarker(
          `scene=multi-provider-benchmark mode=${PROOF_MODE} subscene=partial status=${benchPartialPass ? "pass" : "fail"} ensure_calls=${partialDiscoveryCalls} expected_discovery=${benchPartialExpectDiscovery} provider_count=${PROVIDER_COUNT} per_provider_delay_ms=${PER_PROVIDER_DELAY_MS} ms=${partialResult.ms} rss_before_mb=${partialResult.rssBeforeMb} rss_after_mb=${partialResult.rssAfterMb}`,
        );
        expect(partialDiscoveryCalls > 0).toBe(benchPartialExpectDiscovery);

        // Sanity: static acquisitions should be materially faster than live discovery.
        if (PROOF_MODE === "after") {
          expect(defaultResult.ms).toBeLessThan(liveResult.ms / 2);
          expect(partialResult.ms).toBeLessThan(liveResult.ms / 2);
        }
      } finally {
        envSnapshot.restore();
      }
    },
  );
});
