// Real-behavior proof for PR #123432: the four compaction/media prepared-runtime
// acquisition sites now pass catalogMode "static". This test drives the real
// acquireAgentRunPreparedModelRuntime -> buildSnapshotBatch -> catalog-facts
// control flow. Leaf dependencies (plugin metadata, auth discovery, the catalog
// worker, and the bundled static-catalog resolver) use the prepared-runtime test
// harness so the proof isolates the static-vs-live catalog-mode branch that the
// PR changes; the full-catalog flag (isPreparedModelCatalogFull) and the
// configured-model projection are produced by the real production functions.
//
// Run twice against the same immutable source at BEFORE_SHA and AFTER_SHA with
// PROOF_MODE=before|after. The catalog-mode observable is identical across both
// heads (the option already existed); the before/after caller-boundary difference
// is asserted by the PR's own call-shape tests, which this workflow also runs.
import { beforeEach, describe, expect, it } from "vitest";
// The harness registers vi.mock factories for the prepared-runtime leaf deps; it
// must be imported before the modules under test so the mocks take effect.
import "./prepared-model-runtime.test-harness.js";
import { isPreparedModelCatalogFull } from "./prepared-model-runtime.facts.js";
import { acquireAgentRunPreparedModelRuntime } from "./prepared-model-runtime.js";
import {
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";

const PROOF_MODE = process.env.PROOF_MODE?.trim() || "before";
const CONFIGURED_REF = "openai/gpt-5.6-luna";

const mocks = getPreparedModelRuntimeMocks();

function emitMarker(marker: string): void {
  // [proof] scene=<name> status=<pass|fail> ... is the machine-readable format
  // the proof workflow greps from the run log.
  console.log(`[proof] ${marker}`);
}

function hasConfiguredModel(snapshot: {
  configuredRuntimeModels?: readonly { provider: string; modelId: string }[];
}): boolean {
  return (snapshot.configuredRuntimeModels ?? []).some(
    (entry) => entry.provider === "openai" && entry.modelId === "gpt-5.6-luna",
  );
}

describe("proof: static catalog mode resolves configured models without full catalog", () => {
  beforeEach(() => {
    resetPreparedModelRuntimeHarness();
    // The bundled static-catalog resolver is a leaf double; return a configured
    // model so the real prepareConfiguredRuntimeModels path populates the
    // configured projection for the configured ref.
    mocks.resolveStaticCatalogModel.mockImplementation((lookup: unknown) => {
      const { provider, modelId } = lookup as { provider: string; modelId: string };
      if (provider === "openai" && modelId === "gpt-5.6-luna") {
        return {
          provider: "openai",
          id: "gpt-5.6-luna",
          name: "gpt-5.6-luna",
          api: "openai-responses",
          input: ["text"],
        };
      }
      return undefined;
    });
  });

  it("scene=static skips the full catalog build and resolves the configured model", async () => {
    const lease = await acquireAgentRunPreparedModelRuntime(
      {
        agentId: "default",
        agentDir: "/tmp/proof-static-agent",
        workspaceDir: "/tmp/proof-static-workspace",
        config: { agents: { defaults: { model: CONFIGURED_REF } } },
      },
      { catalogMode: "static" },
    );
    try {
      const snapshot = lease.snapshot;
      const configuredResolved = hasConfiguredModel(snapshot);
      const fullCatalog = isPreparedModelCatalogFull(snapshot.modelCatalog);
      const lazyLoaderPresent = typeof snapshot.loadFullModelCatalog === "function";
      const noLiveSourcePrep = !mocks.ensureOpenClawModelsJson.mock.calls.length;
      const pass = configuredResolved && !fullCatalog && lazyLoaderPresent && noLiveSourcePrep;
      emitMarker(
        `scene=static mode=${PROOF_MODE} status=${pass ? "pass" : "fail"} configured_resolved=${configuredResolved} full_catalog=${fullCatalog} lazy_loader=${lazyLoaderPresent} live_source_prep=${!noLiveSourcePrep}`,
      );
      expect(configuredResolved).toBe(true);
      expect(fullCatalog).toBe(false);
      expect(lazyLoaderPresent).toBe(true);
      expect(noLiveSourcePrep).toBe(true);
    } finally {
      lease.release();
    }
  });

  it("scene=live builds the full catalog as the control baseline", async () => {
    const lease = await acquireAgentRunPreparedModelRuntime({
      agentId: "default",
      agentDir: "/tmp/proof-live-agent",
      workspaceDir: "/tmp/proof-live-workspace",
      config: { agents: { defaults: { model: CONFIGURED_REF } } },
    });
    try {
      const snapshot = lease.snapshot;
      const fullCatalog = isPreparedModelCatalogFull(snapshot.modelCatalog);
      const liveSourcePrep = mocks.ensureOpenClawModelsJson.mock.calls.length > 0;
      const pass = fullCatalog && liveSourcePrep;
      emitMarker(
        `scene=live mode=${PROOF_MODE} status=${pass ? "pass" : "fail"} full_catalog=${fullCatalog} live_source_prep=${liveSourcePrep}`,
      );
      expect(fullCatalog).toBe(true);
      expect(liveSourcePrep).toBe(true);
    } finally {
      lease.release();
    }
  });
});
