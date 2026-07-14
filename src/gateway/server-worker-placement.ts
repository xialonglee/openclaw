import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { revokeAttachGrantsForSession } from "./mcp-grant-store.js";
import type { GatewayWorkerEnvironmentStartupState } from "./server-worker-environment-startup.js";
import type { GatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";
import type { WorkerPlacementDispatchService } from "./worker-environments/placement-dispatch.js";
import type { WorkerEnvironmentService } from "./worker-environments/service.js";

const loadWorkerPlacementStartupModule = createLazyRuntimeModule(
  () => import("./server-worker-placement-startup.js"),
);

// -- approval targeting ----------------------------------------------------

export function approvalRequestTargetsSession(
  request: unknown,
  sessionKeys: ReadonlySet<string>,
  sessionId: string,
): boolean {
  if (typeof request !== "object" || request === null) {
    return false;
  }
  const record = request as { sessionKey?: unknown; sessionId?: unknown };
  return (
    (typeof record.sessionId === "string" && record.sessionId === sessionId) ||
    (typeof record.sessionKey === "string" && sessionKeys.has(record.sessionKey))
  );
}

// -- mutable dispatch cell -------------------------------------------------

type RevokeWorkerDispatchFn = (params: {
  sessionId: string;
  sessionKeys: readonly string[];
}) => void;

/** Mutable cell for lazy-ready worker dispatch authority revocation.
 *  Starts with a throwing placeholder so placement dispatch cannot run
 *  before approval managers exist. */
export function createWorkerDispatchCell(): { current: RevokeWorkerDispatchFn } {
  return {
    current: (_params) => {
      throw new Error("Worker dispatch authority revocation is not ready");
    },
  };
}

// -- placement-runtime bootstrap -------------------------------------------

type BootstrapWorkerPlacementParams = {
  workerEnvironmentService: WorkerEnvironmentService | undefined;
  workerEnvironmentStartup: GatewayWorkerEnvironmentStartupState | undefined;
  startupTrace: { measure: <T>(name: string, fn: () => T) => Promise<T> };
  hasConfiguredWorkerProfiles: boolean;
  log: { warn: (msg: string) => void };
  revokeCell: { current: RevokeWorkerDispatchFn };
};

type BootstrapWorkerPlacementResult = {
  workerPlacementRuntime: GatewayWorkerPlacementRuntime | undefined;
  workerPlacementDispatchAvailable: WorkerPlacementDispatchService | undefined;
};

/** Bootstraps the worker placement runtime and resolves whether dispatch
 *  is available. Without env service or startup info returns undefined/false. */
export async function bootstrapWorkerPlacementRuntime(
  params: BootstrapWorkerPlacementParams,
): Promise<BootstrapWorkerPlacementResult> {
  const { workerEnvironmentService, workerEnvironmentStartup } = params;
  if (!workerEnvironmentService || !workerEnvironmentStartup) {
    return { workerPlacementRuntime: undefined, workerPlacementDispatchAvailable: undefined };
  }
  const placementModule = await loadWorkerPlacementStartupModule();
  const workerPlacementRuntime = placementModule.createGatewayWorkerPlacementRuntime({
    placements: workerEnvironmentStartup.placementStore,
    environments: workerEnvironmentService,
    admitNewPlacements: params.hasConfiguredWorkerProfiles,
    revokeSessionAuthority: (request) => params.revokeCell.current(request),
    warn: (message) => params.log.warn(message),
  });
  return {
    workerPlacementRuntime,
    workerPlacementDispatchAvailable: params.hasConfiguredWorkerProfiles
      ? workerPlacementRuntime.dispatchService
      : undefined,
  };
}

// -- authority revoke factory -----------------------------------------------

type MinimalApprovalManager = {
  listPendingRecords(): { id: string; request: unknown }[];
  expire(id: string, reason: string): void;
};

/** Creates the revoke callback that expires pending exec and plugin approvals
 *  targeting a session and revokes MCP attach grants for its keys. */
export function createWorkerDispatchAuthorityRevoker(params: {
  revokeAttachGrantsForSession: typeof revokeAttachGrantsForSession;
  execApprovalManager: MinimalApprovalManager;
  pluginApprovalManager: MinimalApprovalManager;
}): RevokeWorkerDispatchFn {
  const {
    revokeAttachGrantsForSession: revokeGrants,
    execApprovalManager,
    pluginApprovalManager,
  } = params;
  return ({ sessionId, sessionKeys }) => {
    const keys = new Set(sessionKeys);
    for (const sessionKey of keys) {
      revokeGrants(sessionKey);
    }
    for (const record of execApprovalManager.listPendingRecords()) {
      if (approvalRequestTargetsSession(record.request, keys, sessionId)) {
        execApprovalManager.expire(record.id, "worker-dispatch");
      }
    }
    for (const record of pluginApprovalManager.listPendingRecords()) {
      if (approvalRequestTargetsSession(record.request, keys, sessionId)) {
        pluginApprovalManager.expire(record.id, "worker-dispatch");
      }
    }
  };
}

// -- startup sidecar config -------------------------------------------------

/** Returns a spread-ready object with `startWorkerEnvironmentRuntime` when
 *  placement is available, or an empty object otherwise. */
export function createWorkerPlacementStartupSidecarConfig(
  workerPlacementRuntime: GatewayWorkerPlacementRuntime | undefined,
  hooks: {
    isClosePreludeStarted: () => boolean;
    registerSidecar: (sidecar: { stop: () => Promise<void> }) => void;
  },
): Record<string, unknown> {
  if (!workerPlacementRuntime) {
    return {};
  }
  return {
    startWorkerEnvironmentRuntime: async () => {
      if (hooks.isClosePreludeStarted()) {
        return null;
      }
      return await workerPlacementRuntime.startRuntime({
        isClosePreludeStarted: hooks.isClosePreludeStarted,
        registerSidecar: hooks.registerSidecar,
      });
    },
  };
}
