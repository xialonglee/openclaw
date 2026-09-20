// CI proof probe: stages hostile upload names through the real browser proxy
// staging owner (no mocks, real filesystem) and prints structured markers.
// This file is copied into extensions/browser/src/ by the proof workflow.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import { BROWSER_PROXY_UPLOAD_ENVELOPE } from "./browser-proxy-envelope.js";
import {
  discardStagedBrowserProxyUpload,
  stageBrowserProxyUploadRequest,
} from "./browser-proxy-upload.js";

const CASES = [
  ["trailing-dot", `${"a".repeat(179)}.b`],
  ["trailing-space", `${"b".repeat(179)} c`],
  ["unicode-boundary", `${"c".repeat(175)}🦞.d`],
  ["reserved-con", `CON${" ".repeat(177)}x`],
  ["control", "report.txt"],
] as const;

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("proof: real staging runtime markers", () => {
  it("stages hostile names through the real owner", { timeout: 120_000 }, async () => {
    for (const [scene, name] of CASES) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "browser-upload-proof-"));
      tempRoots.push(root);
      let stagedName = "";
      let writeStatus = "ok";
      let statStatus = "missing";
      try {
        const staged = await stageBrowserProxyUploadRequest({
          method: "POST",
          path: "/hooks/file-chooser",
          body: {},
          upload: {
            envelope: BROWSER_PROXY_UPLOAD_ENVELOPE,
            files: [{ name, contentBase64: "aGVsbG8=" }],
          },
          uploadDir: path.join(root, "uploads"),
        });
        const stagedPath = (staged.body as { paths: string[] }).paths[0] ?? "";
        stagedName = path.basename(stagedPath);
        statStatus = (await fs.stat(stagedPath).catch(() => null))?.isFile() ? "ok" : "missing";
        await discardStagedBrowserProxyUpload(staged);
      } catch (error) {
        writeStatus = `error:${(error as NodeJS.ErrnoException).code ?? String(error).slice(0, 80)}`;
      }
      console.log(
        `[proof] scene=${scene} staged=${JSON.stringify(stagedName)} write=${writeStatus} stat=${statStatus}`,
      );
    }
  });
});
