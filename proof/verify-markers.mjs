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
  const line = markerLines.find((entry) => entry.includes(`scene=${expectation.scene} `));
  if (!line) {
    failures.push(`${expectation.scene}: marker line missing`);
    continue;
  }
  const stagedMatch = line.match(/staged=(.*) write=/u);
  const writeMatch = line.match(/ write=(\S+) stat=/u);
  const statMatch = line.match(/ stat=(\S+)$/u);
  const stagedRaw = stagedMatch?.[1] ?? "";
  const write = writeMatch?.[1] ?? "";
  const stat = statMatch?.[1] ?? "";
  let staged = "";
  try {
    staged = JSON.parse(stagedRaw);
  } catch {
    failures.push(`${expectation.scene}: staged marker is not JSON: ${stagedRaw}`);
    continue;
  }
  if (expectation.staged !== undefined && staged !== expectation.staged) {
    failures.push(
      `${expectation.scene}: staged=${JSON.stringify(staged)} expected=${JSON.stringify(expectation.staged)}`,
    );
  }
  if (expectation.endsWith !== undefined && !staged.endsWith(expectation.endsWith)) {
    failures.push(
      `${expectation.scene}: staged=${JSON.stringify(staged)} expected to end with ${JSON.stringify(expectation.endsWith)}`,
    );
  }
  if (expectation.write !== undefined && write !== expectation.write) {
    failures.push(`${expectation.scene}: write=${write} expected=${expectation.write}`);
  }
  if (expectation.writeIsError && !write.startsWith("error:")) {
    failures.push(`${expectation.scene}: write=${write} expected an error`);
  }
  if (expectation.stat !== undefined && stat !== expectation.stat) {
    failures.push(`${expectation.scene}: stat=${stat} expected=${expectation.stat}`);
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
