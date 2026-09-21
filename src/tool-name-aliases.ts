// ABOUTME: Normalizes model-invented tool names to pi's registered built-in names.
// ABOUTME: Opus/Claude-class models emit read_file/write_file etc. instead of read/write.

/**
 * Alias table mapping the tool names opus/Claude-class models frequently
 * substitute onto pi's actual built-in tool names (`read`, `write`, `edit`,
 * `ls`, `find`).
 *
 * The Kiro backend advertises pi's real tool names in the request's
 * toolSpecification, but the model routinely ignores them and emits its own
 * training-prior names — `read_file`, `write_file`, `str_replace_editor`, and
 * so on. pi then rejects the call with "Tool <name> not found" and the file
 * operation silently fails. Mapping these known aliases at the emit seam lets
 * the call dispatch to the correct built-in.
 *
 * Scope is deliberately narrow: only unambiguous file-operation aliases are
 * listed. Ambiguous names that a session might legitimately register as a
 * distinct tool — `shell`, `search`, `glob`, `terminal` — are intentionally
 * NOT aliased, since rewriting them could misroute a real custom/MCP tool.
 * Any name not present is passed through unchanged.
 */
const TOOL_NAME_ALIASES: Record<string, string> = {
  // read
  read_file: "read",
  readfile: "read",
  fs_read: "read",
  view_file: "read",
  // write
  write_file: "write",
  writefile: "write",
  fs_write: "write",
  create_file: "write",
  // edit
  edit_file: "edit",
  editfile: "edit",
  str_replace: "edit",
  str_replace_editor: "edit",
  str_replace_based_edit_tool: "edit",
  apply_patch: "edit",
  // ls
  list_directory: "ls",
  list_dir: "ls",
  list_files: "ls",
  // find
  find_files: "find",
  file_search: "find",
};

/**
 * Returns the pi built-in tool name for a model-emitted tool name, or the name
 * unchanged when it is not a recognized alias. Matching is case-insensitive on
 * the alias key; the canonical built-in name is returned as-is.
 */
export function normalizeToolName(name: string): string {
  const alias = TOOL_NAME_ALIASES[name.toLowerCase()];
  return alias ?? name;
}
