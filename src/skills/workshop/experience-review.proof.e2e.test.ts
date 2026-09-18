// Real-behavior proof for PR #150837: the failed skill-review outcome recorded
// by the actual `runSkillExperienceReview` catch handler must carry UTF-16-safe
// error text.
//
// workshop-realhandler: drive the REAL review lane into a provider failure (an
// HTTP 400 `{ error: { message } }` body — the exact rejection the official
// experience-review e2e uses). `runSkillExperienceReview` rejects, the REAL
// catch handler records a failed outcome through the REAL production store, and
// we read that persisted outcome back via `readSkillReviewOutcomes` and assert
// the recorded error is valid UTF-16 (<=300 units, no broken surrogate pair, no
// U+FFFD, well-formed). The provider error text is far shorter than 300 units,
// so this scene is an invariant that holds on both heads — the before/after
// differentiator is covered by the doctor scene (corrupted=true/false) and the
// workshop-boundary scene's handlerTruncation field.
//
// workshop-boundary: prove the exact primitive — `.slice(0,300)` on a string
// whose 300th UTF-16 unit sits inside an emoji surrogate pair yields a broken
// lone high surrogate, while `truncateUtf16Safe` retreats the cut to the pair
// boundary. We also read the checked-out tree's own `experience-review.ts`
// source to record which truncation the production catch handler uses, so the
// CI can grep handlerTruncation=slice on BEFORE and handlerTruncation=utf16safe
// on AFTER.
//
// The e2e vitest config runs with `silent: true`, so console output is
// swallowed; every `[proof]` marker line is ALSO appended to
// $PROOF_MARKER_FILE (best effort) so the workflow can collect and grep it.
import { readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { text as readText } from "node:stream/consumers";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAgentRuntimePluginRegistryHandle } from "../../agents/runtime-plugins.js";
import { sanitizeToolUseResultPairingForModel } from "../../agents/session-transcript-repair.js";
import { withServer } from "../../plugin-sdk/test-helpers/http-test-server.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { readSkillReviewOutcomes } from "./collection-review-state.js";
import { observeExperienceReview } from "./experience-review-observation.test-support.js";
import { runSkillExperienceReview } from "./experience-review.js";
import {
  createExperienceReviewCandidate,
  createExperienceReviewMessages,
} from "./experience-review.test-support.js";

const modelId = "gpt-5.6-luna";
const { positiveMessages } = createExperienceReviewMessages(modelId);
const tempDirs = createTrackedTempDirs();
let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "home", prefix: "workshop-proof-truncation-" });
});
afterEach(async () => {
  await state.cleanup();
  await tempDirs.cleanup();
});

function proofLog(line: string): void {
  console.log(line);
  const markerFile = process.env.PROOF_MARKER_FILE ?? "/tmp/proof-workshop.txt";
  try {
    writeFileSync(markerFile, line + "\n", { flag: "a" });
  } catch {
    // best effort: the console line above is also captured by `verbose` runs.
  }
}

function hasBrokenSurrogatePair(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// The official e2e's `failed` scenario server: a plain HTTP 400 JSON rejection.
function badRequestServer(): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      await readText(request);
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Controlled provider rejection" } }));
    })().catch(() => {
      response.writeHead(500).end();
    });
  };
}

describe("proof: real failed-review handler persists UTF-16-safe error text", () => {
  it("records a clean <=300-unit failed-outcome error through the real catch + persisted readback", async () => {
    openOpenClawAgentDatabase({ agentId: "main" });
    await withServer(badRequestServer(), async (baseUrl) => {
      const workspaceDir = await tempDirs.make("workshop-proof-realhandler-");
      const messages = positiveMessages();
      sanitizeToolUseResultPairingForModel(messages, true);
      const candidate = await createExperienceReviewCandidate("proof-realhandler", messages, {
        workspaceDir,
        modelId,
        baseUrl: `${baseUrl}/v1`,
        apiKey: "test-token-placeholder",
      });
      loadAgentRuntimePluginRegistryHandle({ config: candidate.config, workspaceDir });
      const outcomesBefore = new Set(Object.keys(readSkillReviewOutcomes().experienceReviews));

      // The HTTP 400 must reject the review through the REAL catch handler.
      await expect(
        observeExperienceReview(() => runSkillExperienceReview(candidate)),
      ).rejects.toThrow("provider rejected the request schema or tool payload");

      const outcomes = Object.entries(readSkillReviewOutcomes().experienceReviews).filter(
        ([key]) => !outcomesBefore.has(key),
      );
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]![1].outcome).toBe("failed");
      const errorText = String(outcomes[0]![1].error);
      const len = errorText.length;
      const splitPair = hasBrokenSurrogatePair(errorText);
      const replacement = errorText.includes("\uFFFD");
      const wellFormed = errorText.isWellFormed();
      const clean = len > 0 && len <= 300 && !splitPair && !replacement && wellFormed;
      proofLog(
        `[proof] scene=workshop-realhandler status=${clean ? "pass" : "fail"} ` +
          `errorlen=${len} splitPair=${splitPair ? "yes" : "no"} ` +
          `replacement=${replacement ? "yes" : "no"} utf16Valid=${wellFormed ? "yes" : "no"} ` +
          `error_head=${JSON.stringify(errorText.slice(0, 80))}`,
      );
      expect(clean).toBe(true);
    });
  }, 120_000);

  it("proves slice(0,300) breaks a surrogate pair while truncateUtf16Safe stays on the boundary", () => {
    // 301 UTF-16 units: 299 'a' followed by the emoji surrogate pair (299..300).
    const text = "a".repeat(299) + "🚧";
    const sliced = text.slice(0, 300);
    const truncated = truncateUtf16Safe(text, 300);
    const sliceSplitPair = hasBrokenSurrogatePair(sliced);
    const truncatedOk =
      truncated.length === 299 &&
      truncated === "a".repeat(299) &&
      !hasBrokenSurrogatePair(truncated) &&
      !truncated.includes("\uFFFD") &&
      truncated.isWellFormed();
    // Record the length of the wrong slice BEFORE asserting, so the marker still
    // carries the observation even when a head misbehaves.
    const sliceLen = sliced.length;
    proofLog(
      `[proof] scene=workshop-boundary status=${sliceSplitPair && truncatedOk ? "pass" : "fail"} ` +
        `sliceLen=${sliceLen} sliceSplitPair=${sliceSplitPair ? "yes" : "no"} ` +
        `truncatedLen=${truncated.length} truncatedOk=${truncatedOk ? "yes" : "no"} ` +
        `handlerTruncation=${currentHandlerTruncation()}`,
    );
    expect(sliceLen).toBe(300);
    expect(sliceSplitPair).toBe(true);
    expect(truncated).toBe("a".repeat(299));
    expect(truncatedOk).toBe(true);
  });
});

function currentHandlerTruncation(): string {
  let source = "";
  try {
    source = readFileSync(new URL("./experience-review.ts", import.meta.url), "utf8");
  } catch {
    source = readFileSync(
      resolve(process.cwd(), "src/skills/workshop/experience-review.ts"),
      "utf8",
    );
  }
  if (source.includes("truncateUtf16Safe(String(error)")) {
    return "utf16safe";
  }
  if (source.includes("String(error).slice(0, 300)")) {
    return "slice";
  }
  return "unknown";
}
