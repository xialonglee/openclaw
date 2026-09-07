// QA Lab Matrix scenario proves prototype-named msgtypes stay plain text in live reply context.
//
// Remote Matrix peers control msgtype. A room message whose msgtype collides
// with an Object.prototype property name must stay plain text when the gateway
// resolves reply context for the agent, not degrade into a corrupted
// `[matrix [object Object] attachment]`-style media marker. This scenario sends
// hostile msgtype events to a real disposable homeserver, lets the SUT gateway
// ingest them through the normal matrix-js-sdk sync monitor path, and then
// reads the agent transcript through the gateway to assert exactly what text
// reached the model.
import { randomUUID } from "node:crypto";
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

async function readRoomAgentTranscript(context: MatrixQaScenarioContext, roomId: string) {
  if (!context.gatewayCall) {
    throw new Error("Matrix prototype-msgtype scenario requires Gateway call support");
  }
  const listed = await context.gatewayCall("sessions.list", {}, { timeoutMs: 10_000 });
  const sessionKeys = [
    ...new Set(
      [...JSON.stringify(listed).matchAll(/agent:[A-Za-z0-9_-]+:matrix:channel:[^"\\]+/g)].map(
        (match) => match[0],
      ),
    ),
  ];
  const sessionKey = sessionKeys.find((key) => key.includes(roomId));
  if (!sessionKey) {
    throw new Error(`no matrix channel session found for room ${roomId}`);
  }
  return await context.gatewayCall(
    "chat.history",
    { limit: 50, sessionKey },
    { timeoutMs: 10_000 },
  );
}

export async function runProtoMsgtypeReplyContextScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const roomId = resolveMatrixQaScenarioRoomId(context, "proto");
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
  const details = [`room id: ${roomId}`];
  const driverEventIds: string[] = [];
  let since = startSince;

  for (const testCase of PROTO_MSGTYPE_CASES) {
    // The QA text client pins msgtype=m.text; hostile msgtypes must be sent raw
    // so the SUT monitor sees exactly what a remote peer would deliver.
    const hostileBody = `PROTOMSGTYPE ${testCase.label} body ${buildMatrixQaToken("PROTOBODY")}`;
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

  // Assert on the transcript the gateway actually delivered to the agent: the
  // reply-context quote of each hostile event must be plain text, while the
  // control image must keep its attachment marker.
  const transcript = JSON.stringify(await readRoomAgentTranscript(context, roomId));
  const foundCorrupted = CORRUPTED_MARKERS.filter((marker) => transcript.includes(marker));
  if (foundCorrupted.length > 0) {
    throw new Error(
      `[proof] scene=reply-context status=FAIL corrupted media markers reached the agent transcript: ${foundCorrupted.join(" | ")}`,
    );
  }
  if (!transcript.includes(CONTROL_ATTACHMENT_MARKER)) {
    throw new Error(
      `[proof] scene=control-image status=FAIL missing attachment marker ${CONTROL_ATTACHMENT_MARKER} in agent transcript`,
    );
  }
  details.push(
    "[proof] scene=reply-context status=pass prototype-named msgtypes stayed plain text in agent reply context",
  );
  details.push(
    `[proof] scene=control-image status=pass marker=${CONTROL_ATTACHMENT_MARKER} present in agent reply context`,
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
