// Real-behavior probe for PR #150837: UTF-16-safe truncation of doctor warnings
// and workshop skill-review errors. RUN in the checked-out BEFORE/AFTER tree
// (cp -r proof-branch/proof into it) with PROOF_MODE=before|after.
//
// Scene 1 (doctor): the question is whether an over-long warning with an emoji
//   survives the child -> parent handoff uncorrupted. We spawn the real Doctor
//   child (createUpdatePostInstallDoctorResultPath + writeUpdatePostInstallDoctorResult)
//   and consume from the parent (consumeUpdatePostInstallDoctorResult) like the
//   updater does. BEFORE tree slices at the middle of the surrogate pair (corrupt);
//   AFTER tree uses truncateUtf16Safe (clean).
// Scene 2 (workshop): recordSkillExperienceReviewOutcome stores a failed review
//   error; we read it back through readSkillReviewOutcomes on a fresh sqlite.
//   The truncation sits inline inside the catch, so we replicate the exact
//   expression per HEAD (before: String(error).slice(0,300); after: truncateUtf16Safe(String(error),300))
//   and persist through the real production store.
import child_process from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { truncateUtf16Safe } from "../packages/normalization-core/src/utf16-slice.js";
import { consumeUpdatePostInstallDoctorResult } from "../src/infra/update-doctor-result.js";
import {
  readSkillReviewOutcomes,
  recordSkillExperienceReviewOutcome,
} from "../src/skills/workshop/collection-review-state.js";

const MODE = process.env.PROOF_MODE === "before" ? "before" : "after";
const repoRoot = process.cwd();

const clean = (n: number) => "a".repeat(n);
// 501 UTF-16 units: 499 'a' followed by the emoji surrogate pair (indices 499..500).
const EMOJI_501 = clean(499) + "😀";
// 301 UTF-16 units: 299 'a' followed by the emoji surrogate pair (indices 299..300).
const EMOJI_301 = clean(299) + "😀";

function corrupted(value: string): boolean {
  // A lone surrogate cannot survive a UTF-8 encode/decode round trip: strict
  // encoders replace it with U+FFFD, so decoding yields text different from input.
  return new TextDecoder().decode(new TextEncoder().encode(value)) !== value;
}

let failures = 0;

function assertScene(
  scene: string,
  ok: boolean,
  extra: Record<string, string | number | boolean>,
): void {
  console.log(
    `[proof] scene=${scene} mode=${MODE} status=${ok ? "pass" : "fail"} ${Object.entries(extra)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ")}`,
  );
  if (!ok) {
    failures += 1;
  }
}

async function proveDoctor(): Promise<void> {
  const scene = "doctor";
  const warning = EMOJI_501;
  // Spawn the real Doctor child on its own production code, then consume like the updater.
  const workerOut = child_process.execFileSync(
    "pnpm",
    ["exec", "tsx", "proof/doctor-worker.mjs", warning],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const match = /DOCTOR_RESULT_PATH=(\S+)/u.exec(workerOut);
  if (!match) {
    assertScene(scene, false, { corrupted: "?", len: 0, err: "no result path" });
    return;
  }
  const consumed = await consumeUpdatePostInstallDoctorResult(match[1]!);
  const value = consumed?.warnings?.[0] ?? "";
  const isCorrupted = corrupted(value);
  let ok: boolean;
  if (MODE === "before") {
    // BEFORE production code slices through the surrogate pair -> lone high surrogate.
    ok = consumed !== null && value !== clean(499) && isCorrupted === true;
  } else {
    // AFTER production code truncates at the pair boundary -> 499 clean 'a'.
    ok = consumed !== null && value === clean(499) && isCorrupted === false;
  }
  assertScene(scene, ok, { corrupted: isCorrupted, len: value.length });
}

function proveWorkshop(): void {
  const scene = "workshop";
  // Replicate the exact truncation expression at each HEAD semantics.
  const err = MODE === "before" ? EMOJI_301.slice(0, 300) : truncateUtf16Safe(EMOJI_301, 300);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "proof-workshop-"));
  fs.mkdirSync(path.join(tempDir, "state"), { recursive: true });
  try {
    const store = { path: path.join(tempDir, "state", "openclaw.sqlite") };
    recordSkillExperienceReviewOutcome(
      "proof-agent",
      path.join(tempDir, "ws"),
      { attemptedAtMs: Date.now(), outcome: "failed", error: err },
      store,
    );
    const { experienceReviews } = readSkillReviewOutcomes(store);
    const stored = Object.values(experienceReviews)[0] as { error?: string } | undefined;
    const value = stored?.error ?? "";
    const isCorrupted = corrupted(value);
    let ok: boolean;
    if (MODE === "before") {
      ok = stored !== undefined && value !== clean(299) && isCorrupted === true;
    } else {
      ok = stored !== undefined && value === clean(299) && isCorrupted === false;
    }
    assertScene(scene, ok, { corrupted: isCorrupted, len: value.length });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log(`[proof] mode=${MODE}`);
  await proveDoctor();
  proveWorkshop();
  if (failures > 0) {
    console.error(`[proof] ${failures} scene(s) failed`);
    process.exit(1);
  }
  console.log("[proof] all scenes passed");
}

await main();
