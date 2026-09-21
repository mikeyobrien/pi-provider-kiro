import type { Tool } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type KiroInputContext, normalizeKiroContext } from "../src/transform.js";

const read: Tool = { name: "read", description: "Read", parameters: { type: "object", properties: {} } };
const write: Tool = { ...read, name: "write" };
const user = { role: "user" as const, content: "hello", timestamp: 1 };

describe("Pi transcript context compatibility (#161)", () => {
  it("preserves legacy top-level prompt and tools", () => {
    const context = { systemPrompt: "Legacy prompt", tools: [read], messages: [user] };
    expect(normalizeKiroContext(context)).toEqual(context);
  });

  it("extracts Pi 0.86 prompt sections and tools without sending system turns as user history", () => {
    const context: KiroInputContext = {
      messages: [
        {
          role: "system",
          content: "",
          sections: { preamble: "Follow instructions", cwd: "cwd marker" },
          toolsAdded: [read],
          timestamp: 0,
        },
        user,
      ],
    };
    expect(normalizeKiroContext(context)).toEqual({
      systemPrompt: "Follow instructions\n\ncwd marker",
      tools: [read],
      messages: [user],
    });
  });

  it("replays section deletion/replacement and tool removal/replacement without mutating the transcript", () => {
    const updatedRead = { ...read, description: "Updated read" };
    const context: KiroInputContext = {
      systemPrompt: "Legacy",
      tools: [write],
      messages: [
        {
          role: "system",
          content: "Initial",
          sections: { preamble: "Old", cwd: "Remove me" },
          toolsAdded: [read],
          timestamp: 0,
        },
        user,
        {
          role: "system",
          content: [{ type: "text", text: "Update" }],
          sections: { preamble: "New", cwd: null },
          toolsRemoved: [{ name: "write" }],
          toolsAdded: [updatedRead],
          timestamp: 2,
        },
      ],
    };
    const before = structuredClone(context);
    expect(normalizeKiroContext(context)).toEqual({
      systemPrompt: "Legacy\n\nInitial\n\nUpdate\n\nNew",
      tools: [updatedRead],
      messages: [user],
    });
    expect(context).toEqual(before);
  });
});
