// QA Lab Matrix scenario proves prototype-named msgtypes stay plain text in live reply context.
//
// Remote Matrix peers control msgtype. A room message whose msgtype collides
// with an Object.prototype property name must stay plain text when the gateway
// resolves reply context for the agent, not degrade into a corrupted
// `[matrix [object Object] attachment]`-style media marker. This scenario sends
// hostile msgtype events to a real disposable homeserver, lets the SUT gateway
// ingest them through the normal matrix-js-sdk sync monitor path, and then
// asserts on the exact model-facing text the mock provider recorded for the
// agent turn (the transcript display projection strips supplemental quote
// context, so the provider request is the authoritative agent-view surface).
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { requestMatrixJson } from "../substrate/request.js";
import { resolveMatrixQaScenarioRoomId } from "./scenario-contract.js";
import { createMatrixQaSplitColorImagePng } from "./scenario-media-fixtures.js";
import {
  advanceMatrixQaActorCursor,
  buildMatrixQaToken,
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

// The mock provider records every model request; its allInputText is the exact
// agent-facing text for the turn. The provider base URL is only written into
// the gateway config, so read it back from the QA gateway config the harness
// provisioned (same workspace, no secrets in it).
async function readMockProviderInputText(context: MatrixQaScenarioContext): Promise<string> {
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
  return requests
    .map((request) =>
      typeof request === "object" && request !== null
        ? String((request as { allInputText?: unknown }).allInputText ?? "")
        : "",
    )
    .join("\n");
}

function inputExcerpt(inputText: string, maxChars = 2000): string {
  return inputText.length > maxChars ? `${inputText.slice(0, maxChars)}…` : inputText;
}

export async function runProtoMsgtypeReplyContextScenario(
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
    // so the SUT monitor sees exactly what a remote peer would deliver.
    const hostileBody = `PROTOMSGTYPE ${testCase.label} body ${buildMatrixQaToken("PROTOBODY")}`;
    hostileBodies.push(hostileBody);
    const hostileEventId = await sendRawRoomMessage({
      accessToken: context.driverAccessToken,
      baseUrl: context.baseUrl,
      body: hostileBody,
      msgtype: testCase.msgtype,
      roomId,
    });
    driverEventIds.push(hostileEventId);
    const token = buildMatrixQaToken("PROTOK");
    await client.sendTextMessage({
      body: `${context.sutUserId} prototype msgtype reply-context probe (${testCase.label}): reply with only this exact marker: ${token}`,
      mentionUserIds: [context.sutUserId],
      replyToEventId: hostileEventId,
      roomId,
    });
    const matched = await client.waitForRoomEvent({
      observedEvents: context.observedEvents,
      predicate: (event) =>
        isMatrixQaExactMarkerReply(event, { roomId, sutUserId: context.sutUserId, token }),
      roomId,
      since,
      timeoutMs: context.timeoutMs,
    });
    since = matched.since ?? since;
    details.push(
      `[proof] scene=reply-context-${testCase.label} hostileEvent=${hostileEventId} replyEvent=${matched.event.eventId} status=replied`,
    );
  }

  // Control: a legitimate m.image reply target must still render an attachment
  // marker in the agent-visible reply context on both heads.
  const controlCaption = `PROTOCONTROL image caption ${buildMatrixQaToken("PROTOCTL")}`;
  const controlImageEventId = await client.sendMediaMessage({
    body: controlCaption,
    buffer: createMatrixQaSplitColorImagePng(),
    contentType: "image/png",
    fileName: "proto-msgtype-control.png",
    kind: "image",
    mentionUserIds: [context.sutUserId],
    roomId,
  });
  driverEventIds.push(controlImageEventId);
  const controlToken = buildMatrixQaToken("PROTOK");
  await client.sendTextMessage({
    body: `${context.sutUserId} prototype msgtype control probe: reply with only this exact marker: ${controlToken}`,
    mentionUserIds: [context.sutUserId],
    replyToEventId: controlImageEventId,
    roomId,
  });
  const controlMatched = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      isMatrixQaExactMarkerReply(event, {
        roomId,
        sutUserId: context.sutUserId,
        token: controlToken,
      }),
    roomId,
    since,
    timeoutMs: context.timeoutMs,
  });
  since = controlMatched.since ?? since;
  details.push(
    `[proof] scene=control-image imageEvent=${controlImageEventId} replyEvent=${controlMatched.event.eventId} status=replied`,
  );

  advanceMatrixQaActorCursor({
    actorId: "driver",
    syncState: context.syncState,
    nextSince: since,
    startSince,
  });

  // Assert on the exact text the gateway sent to the model for the agent
  // turns: the reply-context quote of each hostile event must be plain text,
  // while the control image must keep its attachment marker.
  const inputText = await readMockProviderInputText(context);
  details.push(`[proof] provider-requests bytes=${inputText.length}`);
  const missingProbe = [...hostileBodies, controlCaption].filter(
    (text) => !inputText.includes(text),
  );
  if (missingProbe.length > 0) {
    throw new Error(
      `[proof] scene=provider-requests status=FAIL probe bodies missing from recorded model input: ${missingProbe.join(" | ")}; excerpt=${inputExcerpt(inputText)}`,
    );
  }
  const foundCorrupted = CORRUPTED_MARKERS.filter((marker) => inputText.includes(marker));
  if (foundCorrupted.length > 0) {
    throw new Error(
      `[proof] scene=reply-context status=FAIL corrupted media markers reached the recorded model input: ${foundCorrupted.join(" | ")}`,
    );
  }
  if (!inputText.includes(CONTROL_ATTACHMENT_MARKER)) {
    throw new Error(
      `[proof] scene=control-image status=FAIL missing attachment marker ${CONTROL_ATTACHMENT_MARKER} in recorded model input; excerpt=${inputExcerpt(inputText)}`,
    );
  }
  details.push(
    "[proof] scene=reply-context status=pass prototype-named msgtypes stayed plain text in recorded model input",
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
