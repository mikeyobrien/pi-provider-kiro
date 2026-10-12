export declare function debugEnabled(): boolean;
export declare function debugLog(section: string, data?: unknown): void;
/** Remove credentials and profile identities from text before exposing it in logs or errors. */
export declare function redactSensitiveText(value: string): string;
/** Return a safe message for an unknown caught value. */
export declare function formatSafeError(error: unknown): string;
