import { EventStreamCodec } from "@smithy/core/event-streams";

const codec = new EventStreamCodec(
  (input: Uint8Array) => new TextDecoder().decode(input),
  (input: string) => new TextEncoder().encode(input),
);

export function encodeEventMessage(payload: object): Uint8Array {
  return codec.encode({
    headers: {
      ":event-type": { type: "string", value: "assistantResponseEvent" },
      ":message-type": { type: "string", value: "event" },
    },
    body: new TextEncoder().encode(JSON.stringify(payload)),
  });
}

export function concatMessages(...msgs: Uint8Array[]): Uint8Array {
  const total = msgs.reduce((sum, m) => sum + m.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const m of msgs) {
    result.set(m, offset);
    offset += m.length;
  }
  return result;
}
