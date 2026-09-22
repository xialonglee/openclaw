// Exact-head proof for openclaw/openclaw#155424:
// "truncate catalog originator and source without splitting surrogate pairs".
//
// Reproduces how OpenClaw's catalog worker projects a Codex app-server
// response, then asserts the projected `originator` field is well-formed.
// Run twice (PROOF_MODE=before / PROOF_MODE=after) on the two immutable
// SHAs so the behavior difference is visible:
//   - BEFORE (main tip): originator sliced with `slice(0, 500)`, which can
//     cut an astral pair in half and leave a lone high surrogate in memory
//     (survives JSON round-trip but becomes U+FFFD through UTF-8 bytes).
//   - AFTER (PR head): truncation is UTF-16-safe, so the unit budget never
//     splits a pair; the projected string is back to a clean 499 units.
//
// The proof drives the REAL @openai/codex app-server binary over stdio JSON-RPC
// (with CODEX_INTERNAL_ORIGINATOR_OVERRIDE to synthesize a long originator),
// captures the raw wire frames, then feeds them through OpenClaw's own catalog
// decoder/projection (createCodexCatalogDecoder) — the exact production path.

import { spawn } from "node:child_process";
import fs, { globSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCodexCatalogDecoder } from "../extensions/codex/src/app-server/client-catalog-response.js";

const MODE: "before" | "after" = process.env.PROOF_MODE === "before" ? "before" : "after";
const repoRoot = process.cwd();

const bin = globSync(
  "node_modules/.pnpm/@openai+codex@*/node_modules/@openai/codex/vendor/*/bin/codex",
  {
    cwd: repoRoot,
  },
)[0];
if (!bin) {
  console.error("[proof] @openai/codex vendor binary not found after pnpm install");
  process.exit(1);
}
const BIN = path.join(repoRoot, bin);

// LONG: 499 ASCII + an astral pair (🙂 U+1F642). Unit length 501; the pair
// spans units 499-500, exactly where a 500-unit cut lands.
const LONG = "s".repeat(499) + "🙂";
const SHORT = "openclaw 🙂 integration";

let fails = 0;
function assertScene(name: string, ok: boolean, extra: string) {
  const status = ok ? "pass" : "fail";
  if (!ok) fails += 1;
  console.log(`[proof] scene=${name} mode=${MODE} status=${status} ${extra}`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
function tailUnit(s: string): string {
  return s.length ? "0x" + s.charCodeAt(s.length - 1).toString(16) : "n/a";
}
function isLoneSurrogate(s: string): boolean {
  if (!s.length) return false;
  const c = s.charCodeAt(s.length - 1);
  return c >= 0xd800 && c <= 0xdfff;
}
function utf8Stable(s: string): boolean {
  return new TextDecoder().decode(Buffer.from(s, "utf8")) === s;
}

// Drive the real codex app-server and capture the raw JSON-RPC frames for the
// thread/list (id = MAX_SAFE_INTEGER, odd -> "list" route) and thread/read
// (id = MAX_SAFE_INTEGER - 1, even -> "thread" route) responses.
async function runSpawn(
  orig: string,
): Promise<{ listRaw: string; readRaw: string; wireLen: number; wireTail: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proof-"));
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(codexHome, { recursive: true });
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });

  const child = spawn(BIN, ["app-server", "--listen", "stdio://"], {
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      HOME: root,
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: orig,
      NO_COLOR: "1",
      CI: "true",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, (m: unknown) => void>();
  const rawById = new Map<number, string>();
  let nextId = 1;
  let buf = "";
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m: { id?: number };
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof m.id === "number") rawById.set(m.id, line);
      if (typeof m.id === "number" && pending.has(m.id)) {
        const p = pending.get(m.id)!;
        pending.delete(m.id);
        p(m);
      }
    }
  });
  // codex logs websocket retry noise on stderr; not part of the wire protocol.
  child.stderr.on("data", () => {});

  const req = (method: string, params: unknown, id?: number) =>
    new Promise<{ result?: any; error?: any }>((resolve) => {
      const rid = id ?? nextId++;
      pending.set(rid, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n");
      setTimeout(() => {
        if (pending.has(rid)) {
          pending.delete(rid);
          resolve({ error: { message: "timeout " + method } });
        }
      }, 60000);
    });

  try {
    await req("initialize", {
      clientInfo: { name: "openclaw", title: "OpenClaw", version: "0" },
      capabilities: { experimentalApi: true },
    });
    const st = await req("thread/start", {
      threadSource: "User",
      cwd: workspace,
      input: [{ type: "text", text: "hi" }],
    });
    const tid = st.result?.thread?.id;
    if (!tid) throw new Error("no thread id: " + JSON.stringify(st).slice(0, 300));
    await req("turn/start", { threadId: tid, input: [{ type: "text", text: "say hi" }] });

    let rows: { originator?: string }[] = [];
    for (let t = 0; t < 20; t++) {
      await sleep(1000);
      const lst = await req("thread/list", { limit: 100, cursor: null }, Number.MAX_SAFE_INTEGER);
      rows = lst.result?.data ?? [];
      if (rows.length > 0) break;
    }
    if (rows.length === 0) throw new Error("thread/list returned no rows");
    const listRaw = rawById.get(Number.MAX_SAFE_INTEGER);
    if (!listRaw) throw new Error("missing thread/list raw frame");

    const rd = await req(
      "thread/read",
      { threadId: tid, includeTurns: false },
      Number.MAX_SAFE_INTEGER - 1,
    );
    if (rd.error || !rd.result?.thread)
      throw new Error("read failed: " + JSON.stringify(rd).slice(0, 300));
    const readRaw = rawById.get(Number.MAX_SAFE_INTEGER - 1);
    if (!readRaw) throw new Error("missing thread/read raw frame");

    return {
      listRaw,
      readRaw,
      wireLen: rows[0]?.originator?.length ?? -1,
      wireTail: tailUnit(rows[0]?.originator ?? ""),
    };
  } finally {
    try {
      child.stdin.end();
    } catch {}
    await sleep(500);
    try {
      child.kill("SIGKILL");
    } catch {}
    await sleep(200);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Feed one raw wire frame through OpenClaw's production catalog projection.
function project(rawLine: string, kind: "list" | "thread"): string {
  const route =
    kind === "list"
      ? { id: Number.MAX_SAFE_INTEGER, kind: "list" as const }
      : { id: Number.MAX_SAFE_INTEGER - 1, kind: "thread" as const };
  const r = createCodexCatalogDecoder()({
    bytes: Buffer.from(rawLine, "utf8"),
    route,
    remainingRows: kind === "list" ? 64 : 0,
  });
  const message: any = r.message;
  const o =
    kind === "list" ? message?.result?.data?.[0]?.originator : message?.result?.thread?.originator;
  if (typeof o !== "string") {
    throw new Error(
      `no projected originator (kind=${kind}): result keys=${message?.result ? String(Object.keys(message.result)) : "none"}`,
    );
  }
  return o;
}

async function main() {
  console.log(`[proof] mode=${MODE}`);

  // Scenes 1+2: projected originator from both catalog routes under LONG override.
  const long = await runSpawn(LONG);
  console.log(
    `[proof] info mode=${MODE} wire_originator_len=${long.wireLen} wire_originator_tail=${long.wireTail}`,
  );

  const listO = project(long.listRaw, "list");
  const listLone = isLoneSurrogate(listO);
  const listUtf8 = utf8Stable(listO);
  if (MODE === "before") {
    assertScene(
      "originator-list",
      listO.length === 500 && listLone && !listUtf8,
      `originator_len=${listO.length} lone_surrogate=${listLone} utf8_stable=${listUtf8} wire_len=${long.wireLen} wire_tail=${long.wireTail}`,
    );
  } else {
    assertScene(
      "originator-list",
      listO.length === 499 && !listLone && listUtf8,
      `originator_len=${listO.length} lone_surrogate=${listLone} utf8_stable=${listUtf8} wire_len=${long.wireLen} wire_tail=${long.wireTail}`,
    );
  }

  const readO = project(long.readRaw, "thread");
  const readLone = isLoneSurrogate(readO);
  const readUtf8 = utf8Stable(readO);
  if (MODE === "before") {
    assertScene(
      "originator-read",
      readO.length === 500 && readLone && !readUtf8,
      `originator_len=${readO.length} lone_surrogate=${readLone} utf8_stable=${readUtf8}`,
    );
  } else {
    assertScene(
      "originator-read",
      readO.length === 499 && !readLone && readUtf8,
      `originator_len=${readO.length} lone_surrogate=${readLone} utf8_stable=${readUtf8}`,
    );
  }

  // Scene 3: a short originator must pass through untouched (regression guard on
  // the truncation path itself — it must not chop non-over-limit strings).
  const short = await runSpawn(SHORT);
  const shortO = project(short.listRaw, "list");
  const preserved = shortO === SHORT;
  assertScene(
    "identity-short",
    preserved,
    `preserved=${preserved} originator_len=${shortO.length} lone_surrogate=${isLoneSurrogate(shortO)} utf8_stable=${utf8Stable(shortO)}`,
  );

  // Scene 4: transport robustness of the PROJECTED originator. The bug is not
  // JSON (lone surrogates survive a JSON.stringify/parse round-trip via escaping),
  // it is UTF-8 byte transport: a lone high surrogate encodes to U+FFFD.
  const jsonRt: unknown = JSON.parse(JSON.stringify({ originator: readO })).originator;
  const jsonFffd = typeof jsonRt === "string" && jsonRt.includes("\uFFFD");
  const rawRt: string = new TextDecoder().decode(Buffer.from(readO, "utf8"));
  const rawFffd = rawRt.includes("\uFFFD");
  if (MODE === "before") {
    assertScene(
      "transport",
      jsonFffd === false && rawFffd === true,
      `json_fffd=${jsonFffd} raw_fffd=${rawFffd} utf8_bytes=${Buffer.from(readO, "utf8").toString("hex").slice(-12)}`,
    );
  } else {
    assertScene(
      "transport",
      jsonFffd === false && rawFffd === false,
      `json_fffd=${jsonFffd} raw_fffd=${rawFffd} utf8_bytes=${Buffer.from(readO, "utf8").toString("hex").slice(-12)}`,
    );
  }

  if (fails > 0) {
    console.log(`[proof] ${fails} scene(s) failed`);
    process.exit(1);
  }
  console.log("[proof] all scenes passed");
}

main().catch((e) => {
  console.error("[proof] fatal error", e);
  process.exit(1);
});
