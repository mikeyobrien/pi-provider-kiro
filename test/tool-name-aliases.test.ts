// ABOUTME: Tests for model-invented tool name normalization to pi built-in names.
// ABOUTME: Covers the read_file/write_file/etc. aliases and pass-through of unknown names.

import { describe, expect, it } from "vitest";
import { normalizeToolName } from "../src/tool-name-aliases.js";

describe("normalizeToolName", () => {
  it("maps read aliases to read", () => {
    expect(normalizeToolName("read_file")).toBe("read");
    expect(normalizeToolName("fs_read")).toBe("read");
    expect(normalizeToolName("view_file")).toBe("read");
  });

  it("maps write aliases to write", () => {
    expect(normalizeToolName("write_file")).toBe("write");
    expect(normalizeToolName("fs_write")).toBe("write");
    expect(normalizeToolName("create_file")).toBe("write");
  });

  it("maps edit aliases to edit", () => {
    expect(normalizeToolName("edit_file")).toBe("edit");
    expect(normalizeToolName("str_replace")).toBe("edit");
    expect(normalizeToolName("str_replace_editor")).toBe("edit");
    expect(normalizeToolName("str_replace_based_edit_tool")).toBe("edit");
    expect(normalizeToolName("apply_patch")).toBe("edit");
  });

  it("does NOT alias ambiguous command-runner names", () => {
    // Intentionally NOT aliased — ambiguous with legitimate session tools.
    expect(normalizeToolName("shell")).toBe("shell");
    expect(normalizeToolName("run_command")).toBe("run_command");
    expect(normalizeToolName("execute_command")).toBe("execute_command");
    expect(normalizeToolName("run_terminal_cmd")).toBe("run_terminal_cmd");
  });

  it("maps directory aliases and leaves ambiguous search names alone", () => {
    expect(normalizeToolName("list_directory")).toBe("ls");
    expect(normalizeToolName("list_dir")).toBe("ls");
    expect(normalizeToolName("find_files")).toBe("find");
    expect(normalizeToolName("file_search")).toBe("find");
    // Ambiguous — a session may register a distinct tool with these names.
    expect(normalizeToolName("search")).toBe("search");
    expect(normalizeToolName("glob")).toBe("glob");
  });

  it("is case-insensitive on the alias key", () => {
    expect(normalizeToolName("Read_File")).toBe("read");
    expect(normalizeToolName("WRITE_FILE")).toBe("write");
  });

  it("passes through canonical built-in names unchanged", () => {
    expect(normalizeToolName("read")).toBe("read");
    expect(normalizeToolName("write")).toBe("write");
    expect(normalizeToolName("edit")).toBe("edit");
    expect(normalizeToolName("bash")).toBe("bash");
  });

  it("passes through unknown/custom/MCP tool names unchanged", () => {
    expect(normalizeToolName("herdr_pane")).toBe("herdr_pane");
    expect(normalizeToolName("mcp__server__do_thing")).toBe("mcp__server__do_thing");
    expect(normalizeToolName("obsidian")).toBe("obsidian");
    expect(normalizeToolName("some_custom_tool")).toBe("some_custom_tool");
  });
});
