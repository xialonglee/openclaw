import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createConfigIO } from "./io.js";
import { withTempHome } from "./test-helpers.js";

describe("loadConfig non-object config", () => {
  it("warns and returns defaults when config is a bare string", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, '"just a string"', "utf-8");

      const logger = { error: vi.fn(), warn: vi.fn() };
      const io = createConfigIO({
        configPath,
        env: { HOME: home } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger,
        pluginValidation: "skip",
      });

      const config = io.loadConfig();

      expect(config).toEqual({});
      expect(logger.warn).toHaveBeenCalledWith(
        `Config at ${configPath} is not a JSON object; using defaults`,
      );
    });
  });

  it("warns and returns defaults when config is a bare number", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, "42", "utf-8");

      const logger = { error: vi.fn(), warn: vi.fn() };
      const io = createConfigIO({
        configPath,
        env: { HOME: home } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger,
        pluginValidation: "skip",
      });

      const config = io.loadConfig();

      expect(config).toEqual({});
      expect(logger.warn).toHaveBeenCalledWith(
        `Config at ${configPath} is not a JSON object; using defaults`,
      );
    });
  });

  it("warns and returns defaults when config is null", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, "null", "utf-8");

      const logger = { error: vi.fn(), warn: vi.fn() };
      const io = createConfigIO({
        configPath,
        env: { HOME: home } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger,
        pluginValidation: "skip",
      });

      const config = io.loadConfig();

      expect(config).toEqual({});
      expect(logger.warn).toHaveBeenCalledWith(
        `Config at ${configPath} is not a JSON object; using defaults`,
      );
    });
  });
});
