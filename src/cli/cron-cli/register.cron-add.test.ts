// Regression tests for cron-add delivery-option validation,
// especially the explicit --channel/--to guard for system-event (main-session) jobs.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayFromCli = vi.fn();
const runtimeExit = vi.fn();

vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      callGatewayFromCli(...args),
  };
});

vi.mock("../../runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../runtime.js")>("../../runtime.js");
  return {
    ...actual,
    defaultRuntime: {
      ...actual.defaultRuntime,
      exit: runtimeExit,
    },
  };
});

const { registerCronAddCommand } = await import("./register.cron-add.js");

function createCronAddProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerCronAddCommand(program);
  return program;
}

const BASE_SYSTEM_EVENT_ARGS = [
  "add",
  "--name",
  "test-job",
  "--every",
  "1h",
  "--system-event",
  "wakeup",
];

const BASE_ISOLATED_AGENT_ARGS = [
  "add",
  "--name",
  "test-job",
  "--every",
  "1h",
  "--message",
  "hello",
];

describe("cron add delivery-option validation", () => {
  beforeEach(() => {
    callGatewayFromCli.mockReset();
    callGatewayFromCli.mockResolvedValue({ ok: true });
    runtimeExit.mockReset();
    // Make runtime.exit throw so the error propagates to parseAsync reject handler.
    runtimeExit.mockImplementation((code: number) => {
      throw new Error(`runtime.exit(${code})`);
    });
  });

  describe("system-event (main session) jobs", () => {
    it("rejects explicit --channel for system-event jobs", async () => {
      const program = createCronAddProgram();
      await expect(
        program.parseAsync([...BASE_SYSTEM_EVENT_ARGS, "--channel", "last"], {
          from: "user",
        }),
      ).rejects.toThrow(/runtime\.exit/);
      expect(runtimeExit).toHaveBeenCalledWith(1);
    });

    it("rejects explicit --to for system-event jobs", async () => {
      const program = createCronAddProgram();
      await expect(
        program.parseAsync([...BASE_SYSTEM_EVENT_ARGS, "--to", "+1234567890"], {
          from: "user",
        }),
      ).rejects.toThrow(/runtime\.exit/);
      expect(runtimeExit).toHaveBeenCalledWith(1);
    });

    it("rejects --account for system-event jobs", async () => {
      const program = createCronAddProgram();
      await expect(
        program.parseAsync([...BASE_SYSTEM_EVENT_ARGS, "--account", "acct-123"], { from: "user" }),
      ).rejects.toThrow(/runtime\.exit/);
      expect(runtimeExit).toHaveBeenCalledWith(1);
    });

    it("rejects --thread-id for system-event jobs", async () => {
      const program = createCronAddProgram();
      await expect(
        program.parseAsync([...BASE_SYSTEM_EVENT_ARGS, "--thread-id", "42"], { from: "user" }),
      ).rejects.toThrow(/runtime\.exit/);
      expect(runtimeExit).toHaveBeenCalledWith(1);
    });

    it("allows system-event job without explicit --channel (default channel value)", async () => {
      const program = createCronAddProgram();
      await expect(
        program.parseAsync(BASE_SYSTEM_EVENT_ARGS, { from: "user" }),
      ).resolves.not.toThrow();
      expect(callGatewayFromCli).toHaveBeenCalledWith(
        "cron.add",
        expect.anything(),
        expect.objectContaining({ name: "test-job" }),
      );
    });

    it("allows system-event job with --webhook (webhook delivery preserved)", async () => {
      const program = createCronAddProgram();
      await expect(
        program.parseAsync([...BASE_SYSTEM_EVENT_ARGS, "--webhook", "https://example.com/hook"], {
          from: "user",
        }),
      ).resolves.not.toThrow();
      expect(callGatewayFromCli).toHaveBeenCalledWith(
        "cron.add",
        expect.anything(),
        expect.objectContaining({ name: "test-job" }),
      );
    });

    it("rejects --channel even when --webhook is also passed (first guard wins)", async () => {
      const program = createCronAddProgram();
      await expect(
        program.parseAsync(
          [
            ...BASE_SYSTEM_EVENT_ARGS,
            "--channel",
            "telegram",
            "--webhook",
            "https://example.com/hook",
          ],
          { from: "user" },
        ),
      ).rejects.toThrow(/runtime\.exit/);
      expect(runtimeExit).toHaveBeenCalledWith(1);
    });
  });

  describe("isolated agentTurn jobs", () => {
    it("allows --channel for isolated agentTurn jobs", async () => {
      const program = createCronAddProgram();
      await expect(
        program.parseAsync([...BASE_ISOLATED_AGENT_ARGS, "--channel", "telegram"], {
          from: "user",
        }),
      ).resolves.not.toThrow();
      expect(callGatewayFromCli).toHaveBeenCalledWith(
        "cron.add",
        expect.anything(),
        expect.objectContaining({ name: "test-job" }),
      );
    });

    it("allows --to for isolated agentTurn jobs", async () => {
      const program = createCronAddProgram();
      await expect(
        program.parseAsync([...BASE_ISOLATED_AGENT_ARGS, "--to", "+1234567890"], { from: "user" }),
      ).resolves.not.toThrow();
      expect(callGatewayFromCli).toHaveBeenCalledWith(
        "cron.add",
        expect.anything(),
        expect.objectContaining({ name: "test-job" }),
      );
    });
  });
});
