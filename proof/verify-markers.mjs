// Verifies [proof] scene markers in the proof log against per-profile expectations.
// Usage: PROFILE=before-linux|after-linux|before-windows|after-windows node proof/verify-markers.mjs
import fs from "node:fs";

const log = fs.readFileSync(process.env.PROOF_LOG || "proof-source/proof.log", "utf8");
const profileName = process.env.PROFILE;
const repeat = (character, count) => character.repeat(count);

const LINUX_AFTER = [
  { scene: "trailing-dot", staged: `${repeat("a", 179)}` },
  { scene: "trailing-space", staged: `${repeat("b", 179)}` },
  { scene: "unicode-boundary", staged: `${repeat("c", 175)}🦞` },
  { scene: "reserved-con", staged: "_CON" },
  { scene: "control", staged: "report.txt", write: "ok", stat: "ok" },
];

const profiles = {
  "before-linux": [
    { scene: "trailing-dot", staged: `${repeat("a", 179)}.` },
    { scene: "trailing-space", staged: `${repeat("b", 179)} ` },
    { scene: "unicode-boundary", staged: `${repeat("c", 175)}🦞.` },
    { scene: "reserved-con", staged: `CON${repeat(" ", 177)}` },
    { scene: "control", staged: "report.txt", write: "ok", stat: "ok" },
  ],
  "after-linux": LINUX_AFTER,
  "before-windows": [
    { scene: "trailing-dot", staged: `${repeat("a", 179)}.`, write: "ok", stat: "ok" },
    { scene: "trailing-space", staged: `${repeat("b", 179)} `, write: "ok", stat: "ok" },
    { scene: "unicode-boundary", staged: `${repeat("c", 175)}🦞.`, write: "ok", stat: "ok" },
    { scene: "reserved-con", staged: `CON${repeat(" ", 177)}`, write: "ok", stat: "ok" },
    { scene: "control", staged: "report.txt", write: "ok", stat: "ok" },
  ],
  "after-windows": [
    { scene: "trailing-dot", staged: `${repeat("a", 179)}`, write: "ok", stat: "ok" },
    { scene: "trailing-space", staged: `${repeat("b", 179)}`, write: "ok", stat: "ok" },
    { scene: "unicode-boundary", staged: `${repeat("c", 175)}🦞`, write: "ok", stat: "ok" },
    { scene: "reserved-con", staged: "_CON", write: "ok", stat: "ok" },
    { scene: "control", staged: "report.txt", write: "ok", stat: "ok" },
  ],
};

const profile = profiles[profileName];
if (!profile) {
  throw new Error(`unknown PROFILE=${profileName}`);
}

const markerLines = log
  .split("\n")
  .filter((line) => line.includes("[proof] scene=") && line.includes(" write="));

const failures = [];
for (const expectation of profile) {
  const candidates = markerLines.filter((entry) => entry.includes(`scene=${expectation.scene} `));
  if (candidates.length === 0) {
    failures.push(`${expectation.scene}: marker line missing`);
    continue;
  }
  const parsed = candidates.map((line) => {
    const stagedMatch = line.match(/staged=(.*) write=/u);
    const writeMatch = line.match(/ write=(\S+) stat=/u);
    const statMatch = line.match(/ stat=(\S+)$/u);
    let staged = null;
    try {
      staged = JSON.parse(stagedMatch?.[1] ?? "");
    } catch {
      staged = null;
    }
    return { staged, write: writeMatch?.[1] ?? "", stat: statMatch?.[1] ?? "", line };
  });
  const matched = parsed.some((candidate) => {
    if (candidate.staged === null) {
      return false;
    }
    if (expectation.staged !== undefined && candidate.staged !== expectation.staged) {
      return false;
    }
    if (expectation.endsWith !== undefined && !candidate.staged.endsWith(expectation.endsWith)) {
      return false;
    }
    if (expectation.write !== undefined && candidate.write !== expectation.write) {
      return false;
    }
    if (expectation.writeIsError && !candidate.write.startsWith("error:")) {
      return false;
    }
    if (expectation.stat !== undefined && candidate.stat !== expectation.stat) {
      return false;
    }
    return true;
  });
  if (!matched) {
    failures.push(
      `${expectation.scene}: no marker matched expectation; saw ${parsed
        .map(
          (candidate) =>
            `staged=${JSON.stringify(candidate.staged)} write=${candidate.write} stat=${candidate.stat}`,
        )
        .join(" | ")}`,
    );
  }
}

if (failures.length > 0) {
  console.error(`[proof] markers FAILED profile=${profileName}`);
  for (const failure of failures) {
    console.error(`[proof]   ${failure}`);
  }
  process.exit(1);
}
console.log(`[proof] markers-verified profile=${profileName} scenes=${profile.length}`);
