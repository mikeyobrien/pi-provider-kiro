/**
 * Members of the `ChatResponseStream` tagged union emitted by
 * `generateAssistantResponse` on `runtime.{region}.kiro.dev`.
 *
 * Source of truth: the generated Smithy client for the same service
 * (`@amzn/kiro-runtime-service-typescript-client`, `ChatResponseStream`).
 * The frame's `:event-type` header carries one of these keys, so routing is a
 * switch on the key rather than a guess based on which fields happen to be set.
 */
export declare const KIRO_EVENT_KEYS: readonly ["assistantResponseEvent", "codeReferenceEvent", "contextUsageEvent", "documentCitationEvent", "error", "metadataEvent", "meteringEvent", "reasoningContentEvent", "serviceUnavailableError", "throttlingError", "toolResultEvent", "toolUseEvent", "validationError"];
export type KiroEventKey = (typeof KIRO_EVENT_KEYS)[number];
export declare function isKiroEventKey(key: string): key is KiroEventKey;
/** Token accounting from `MetadataEvent.tokenUsage`. */
export type KiroUsageData = {
    /** `TokenUsage.uncachedInputTokens` — input tokens billed at full rate. */
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheReadInputTokens?: number;
    cacheWriteInputTokens?: number;
    contextUsagePercentage?: number;
    /**
     * `TokenUsage.normalizedTokenUsage` — usage normalized by MPS from credit
     * information. Distinct from `MeteringEvent.usage`, which is a raw credit
     * count; surfaced so it is not dropped at the boundary like the rest of
     * `MetadataEvent` was.
     */
    normalizedTokenUsage?: number;
    /** `MetadataEvent.stopReason`, passed through verbatim. */
    rawStopReason?: string;
    /** `MetadataEvent.stopDetails`, passed through verbatim. */
    stopDetails?: Record<string, unknown>;
};
/** Which modeled union member produced an error event. */
export type KiroErrorKind = "internalServer" | "throttling" | "validation" | "serviceUnavailable" | "unknown";
/**
 * The four error members of `ChatResponseStream` target `@error` shapes, so the
 * service frames them as `:message-type: exception` with the union member name
 * in `:exception-type` — not as ordinary `event` frames. Mapping the member to
 * its exception class here keeps both framings on one table.
 */
export declare const KIRO_ERROR_MEMBERS: Readonly<Record<string, {
    kind: KiroErrorKind;
    exception: string;
}>>;
/**
 * Look up an error member by a token the SERVICE chose.
 *
 * `KIRO_ERROR_TOKENS` is an ordinary object literal, so a bare index would
 * also resolve inherited `Object.prototype` members: an `:exception-type` of
 * `toString` or `constructor` returns a truthy value whose `kind` and
 * `exception` are both undefined, silently discarding the member name this
 * routing exists to preserve. Only own properties count as modeled members.
 */
export declare function lookupKiroErrorMember(key: string): {
    kind: KiroErrorKind;
    exception: string;
} | undefined;
export type KiroErrorData = {
    /** Exception class name, or the legacy free-form `error` string. */
    error: string;
    message?: string;
    kind: KiroErrorKind;
    /** `ThrottlingException.reason` / `ValidationException.reason`, passed through. */
    reason?: string;
    /** `ThrottlingException.retryAfterMilliseconds`. */
    retryAfterMilliseconds?: number;
};
export type KiroStreamEvent = {
    type: "content";
    data: string;
} | {
    type: "thinkingText";
    data: string;
} | {
    type: "thinkingSignature";
    data: string;
} | {
    type: "toolUse";
    data: {
        name: string;
        toolUseId: string;
        input: string;
        stop?: boolean;
    };
} | {
    type: "toolUseInput";
    data: {
        input: string;
    };
} | {
    type: "toolUseStop";
    data: {
        stop: boolean;
    };
} | {
    type: "contextUsage";
    data: {
        contextUsagePercentage: number;
    };
} | {
    type: "followupPrompt";
    data: string;
} | {
    type: "usage";
    data: KiroUsageData;
}
/** `MeteringEvent` — `usage` is a COUNT OF CREDITS, not tokens. */
 | {
    type: "metering";
    data: {
        credits?: number;
        unit?: string;
        unitPlural?: string;
    };
} | {
    type: "error";
    data: KiroErrorData;
}
/** A known union member with no consumer yet. Kept distinct from unparseable. */
 | {
    type: "ignored";
    data: {
        key: string;
    };
};
/**
 * Route a decoded stream frame by its modeled `:event-type` key.
 *
 * `key` is the `ChatResponseStream` union member name from the frame header.
 * An unrecognized key falls back to {@link parseKiroEventByShape} so a member
 * added server-side degrades instead of breaking the stream.
 *
 * Note: a frame whose `:event-type` is the literal `$unknown` never reaches
 * here. The Smithy marshaller drops any event frame for which the deserializer
 * returns a `$unknown` property, and the deserializer keys its result by the
 * header value, so `$unknown` is discarded one layer up. The fallback below is
 * therefore reached only by a real, unrecognized member name.
 */
export declare function parseKiroEvent(key: string, parsed: Record<string, unknown>): KiroStreamEvent | null;
/**
 * Route an `:message-type: exception` frame by its `:exception-type` token.
 *
 * The Smithy marshaller throws whatever the deserializer returns for that key,
 * so this is the only place the modeled exception class, `reason`, and
 * `retryAfterMilliseconds` are still structured. Accepts either token form the
 * service uses (union member name or exception class name). Returns `null` for
 * a token that is not one of the four modeled errors; the caller is responsible
 * for still preserving that name (see `src/stream.ts`), because Smithy's own
 * raw-body fallback only fires for a `$unknown` result this deserializer never
 * produces.
 */
export declare function parseKiroExceptionFrame(key: string, parsed: Record<string, unknown>): KiroErrorData | null;
/**
 * Fail-open fallback for frames carrying an unrecognized `:event-type`.
 *
 * Order-dependent field sniffing. Only reachable when the frame's key is not a
 * known `ChatResponseStream` member; modeled frames never reach here.
 */
export declare function parseKiroEventByShape(parsed: Record<string, unknown>): KiroStreamEvent | null;
