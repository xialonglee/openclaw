// QA Lab Matrix scenario proves prototype-named msgtypes stay plain text in live thread context.
//
// Remote Matrix peers control msgtype. A room message whose msgtype collides
// with an Object.prototype property name must stay plain text when the gateway
// summarizes the thread root for the agent, not degrade into a corrupted
// `[matrix function Object() { [native code] } attachment]`-style media marker.
// This scenario sends hostile msgtype events to a real disposable homeserver,
// lets the SUT gateway ingest them through the normal matrix-js-sdk sync
// monitor path, and then asserts on the exact model-facing text the mock
// provider recorded for the agent turn. The thread-starter summary is the
// agent-view surface here: the reply-quote block is skipped when the chat
// window already covers the reply target, while the thread starter block is
// always injected when present.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { requestMatrixJson } from "../substrate/request.js";
import { resolveMatrixQaScenarioRoomId } from "./scenario-contract.js";
import { createMatrixQaSplitColorImagePng } from "./scenario-media-fixtures.js";
import {
  advanceMatrixQaActorCursor,
  buildMatrixQaToken,
  buildMentionPrompt,
  isMatrixQaExactMarkerReply,
  primeMatrixQaDriverScenarioClient,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

// Exact markers the pre-fix inherited-property lookup injected into agent text.
const CORRUPTED_MARKERS = [
  "[matrix function Object() { [native code] } attachment]",
  "[matrix [object Object] attachment]",
] as const;
const CONTROL_ATTACHMENT_MARKER = "[matrix image attachment]";

const PROTO_MSGTYPE_CASES = [
  { label: "toString", msgtype: "toString" },
  { label: "__proto__", msgtype: "__proto__" },
] as const;

async function sendRawRoomMessage(params: {
  accessToken: string;
  baseUrl: string;
  body: string;
  msgtype: string;
  roomId: string;
}): Promise<string> {
  const result = await requestMatrixJson<{ event_id?: string }>({
    accessToken: params.accessToken,
    baseUrl: params.baseUrl,
    body: { body: params.body, msgtype: params.msgtype },
    endpoint: `/_matrix/client/v3/rooms/${encodeURIComponent(params.roomId)}/send/m.room.message/${encodeURIComponent(randomUUID())}`,
    fetchImpl: fetch,
    method: "PUT",
  });
  const eventId = result.body.event_id?.trim();
  if (!eventId) {
    throw new Error("Matrix raw prototype-msgtype send did not return an event id");
  }
  return eventId;
}

type RecordedMockRequest = {
  cursor?: unknown;
  model?: unknown;
  requestKind?: unknown;
  outcome?: unknown;
  allInputText?: unknown;
  raw?: unknown;
};

// The mock provider records every model request; its allInputText is the exact
// agent-facing text for the turn. The provider base URL is only written into
// the gateway config, so read it back from the QA gateway config the harness
// provisioned (same workspace, no secrets in it).
async function readMockProviderRequests(
  context: MatrixQaScenarioContext,
): Promise<RecordedMockRequest[]> {
  const configPath = context.gatewayRuntimeEnv?.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Matrix prototype-msgtype scenario requires the QA gateway config path");
  }
  const parsed: unknown = JSON.parse(await fs.readFile(configPath, "utf8"));
  const baseUrl =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { models?: { providers?: { openai?: { baseUrl?: unknown } } } }).models
          ?.providers?.openai?.baseUrl
      : undefined;
  if (typeof baseUrl !== "string" || !baseUrl) {
    throw new Error("mock provider baseUrl missing from QA gateway config");
  }
  const mockRoot = baseUrl.replace(/\/v1\/?$/u, "");
  const response = await fetch(`${mockRoot}/debug/requests`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`mock provider /debug/requests returned status ${response.status}`);
  }
  const requests: unknown = await response.json();
  if (!Array.isArray(requests)) {
    throw new Error("mock provider /debug/requests returned a non-array payload");
  }
  return requests as RecordedMockRequest[];
}

// Scan both the extracted text and the raw wire body: the gateway may use a
// non-Responses wire shape whose extracted allInputText is partial.
function joinRecordedInputText(requests: RecordedMockRequest[]): string {
  return requests
    .map((request) => [String(request.allInputText ?? ""), String(request.raw ?? "")].join("\n"))
    .join("\n");
}

// Per-request one-line digest so a probe miss is self-explanatory in CI logs.
function summarizeRecordedRequests(requests: RecordedMockRequest[]): string {
  return requests
    .map((request) => {
      const text = String(request.allInputText ?? "");
      const head = text.replace(/\s+/gu, " ").trim().slice(0, 120);
      return `cursor=${String(request.cursor)} model=${String(request.model)} kind=${String(request.requestKind)} outcome=${String(request.outcome)} inputBytes=${text.length} head=${head}`;
    })
    .join("\n");
}

export async function runProtoMsgtypeThreadContextScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const roomId = resolveMatrixQaScenarioRoomId(context, "proto");
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
  const details = [`room id: ${roomId}`];
  const driverEventIds: string[] = [];
  const hostileBodies: string[] = [];
  let since = startSince;

  for (const testCase of PROTO_MSGTYPE_CASES) {
    // The QA text client pins msgtype=m.text; hostile msgtypes must be sent raw
    // so the SUT monitor sees exactly what a remote peer would deliver. The
    // hostile event becomes a thread root so the gateway summarizes it into the
    // thread-starter block of the agent prompt on the next mention turn.
    const hostileBody = `PROTOMSGTYPE ${testCase.label} body ${buildMatrixQaToken("PROTOBODY")}`;
    hostileBodies.push(hostileBody);
    const hostileEventId = await sendRawRoomMessage({
      accessToken: context.driverAccessToken,
      baseUrl: context.baseUrl,
      body: hostileBody,
      msgtype: testCase.msgtype,
      roomId,
    });
    const token = buildMatrixQaToken("PROTOK");
    const triggerEventId = await client.sendTextMessage({
      body: `${buildMentionPrompt(context.sutUserId, token)} prototype msgtype thread probe (${testCase.label})`,
      mentionUserIds: [context.sutUserId],
      roomId,
      threadRootEventId: hostileEventId,
    });
    driverEventIds.push(hostileEventId, triggerEventId);
    const matched = await client.waitForRoomEvent({
      observedEvents: context.observedEvents,
      predicate: (event) =>
        isMatrixQaExactMarkerReply(event, { roomId, sutUserId: context.sutUserId, token }) &&
        event.relatesTo?.relType === "m.thread" &&
        event.relatesTo.eventId === hostileEventId,
      roomId,
      since,
      timeoutMs: context.timeoutMs,
    });
    since = matched.since ?? since;
    details.push(
      `[proof] scene=thread-context-${testCase.label} hostileEvent=${hostileEventId} triggerEvent=${triggerEventId} replyEvent=${matched.event.eventId} status=replied`,
    );
  }

  // Control: a legitimate m.image thread root must still render its attachment
  // marker in the agent-visible thread starter on both heads.
  const controlCaption = `PROTOCONTROL image caption ${buildMatrixQaToken("PROTOCTL")}`;
  const controlImageEventId = await client.sendMediaMessage({
    body: controlCaption,
    buffer: createMatrixQaSplitColorImagePng(),
    contentType: "image/png",
    fileName: "proto-msgtype-control.png",
    kind: "image",
    roomId,
  });
  const controlToken = buildMatrixQaToken("PROTOK");
  const controlTriggerEventId = await client.sendTextMessage({
    body: `${buildMentionPrompt(context.sutUserId, controlToken)} prototype msgtype control probe`,
    mentionUserIds: [context.sutUserId],
    roomId,
    threadRootEventId: controlImageEventId,
  });
  driverEventIds.push(controlImageEventId, controlTriggerEventId);
  const controlMatched = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      isMatrixQaExactMarkerReply(event, {
        roomId,
        sutUserId: context.sutUserId,
        token: controlToken,
      }) &&
      event.relatesTo?.relType === "m.thread" &&
      event.relatesTo.eventId === controlImageEventId,
    roomId,
    since,
    timeoutMs: context.timeoutMs,
  });
  since = controlMatched.since ?? since;
  details.push(
    `[proof] scene=control-image imageEvent=${controlImageEventId} triggerEvent=${controlTriggerEventId} replyEvent=${controlMatched.event.eventId} status=replied`,
  );

  advanceMatrixQaActorCursor({
    actorId: "driver",
    syncState: context.syncState,
    nextSince: since,
    startSince,
  });

  // Assert on the exact text the gateway sent to the model for the agent
  // turns: the thread-starter summary of each hostile event must be plain text,
  // while the control image must keep its attachment marker.
  const requests = await readMockProviderRequests(context);
  const inputText = joinRecordedInputText(requests);
  details.push(`[proof] provider-requests count=${requests.length} inputBytes=${inputText.length}`);
  const missingProbe = [...hostileBodies, controlCaption].filter(
    (text) => !inputText.includes(text),
  );
  if (missingProbe.length > 0) {
    throw new Error(
      `[proof] scene=provider-requests status=FAIL probe bodies missing from recorded model input: ${missingProbe.join(" | ")}; recorded:\n${summarizeRecordedRequests(requests)}`,
    );
  }
  const foundCorrupted = CORRUPTED_MARKERS.filter((marker) => inputText.includes(marker));
  if (foundCorrupted.length > 0) {
    throw new Error(
      `[proof] scene=thread-context status=FAIL corrupted media markers reached the recorded model input: ${foundCorrupted.join(" | ")}`,
    );
  }
  if (!inputText.includes(CONTROL_ATTACHMENT_MARKER)) {
    throw new Error(
      `[proof] scene=control-image status=FAIL missing attachment marker ${CONTROL_ATTACHMENT_MARKER} in recorded model input; recorded:\n${summarizeRecordedRequests(requests)}`,
    );
  }
  details.push(
    "[proof] scene=thread-context status=pass prototype-named msgtypes stayed plain text in recorded model input",
  );
  details.push(
    `[proof] scene=control-image status=pass marker=${CONTROL_ATTACHMENT_MARKER} present in recorded model input`,
  );

  return {
    artifacts: {
      attachments: [
        {
          eventId: controlImageEventId,
          filename: "proto-msgtype-control.png",
          kind: "image",
          label: "control-image",
          msgtype: "m.image",
        },
      ],
      driverEventIds,
      roomId,
    },
    details: details.join("\n"),
  };
}
