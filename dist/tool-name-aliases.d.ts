/**
 * Returns the pi built-in tool name for a model-emitted tool name, or the name
 * unchanged when it is not a recognized alias. Matching is case-insensitive on
 * the alias key; the canonical built-in name is returned as-is.
 */
export declare function normalizeToolName(name: string): string;
