import type { Api, AssistantMessageEventStream, Context, Model, Message as PiMessage, SimpleStreamOptions, TextContent, Tool } from "@earendil-works/pi-ai";
import { type KiroUsageTracking } from "./usage-tracking.js";
/** Minimal structural view of a refreshed Kiro credential handed to the host's
 *  accessor. A superset lives in `oauth.ts` (`KiroCredentials`); this pins only
 *  what write-back reads so the accessor contract does not couple to that type. */
export interface KiroCredentialLike {
    access: string;
    expires?: number;
    region?: string;
    profileArn?: string;
    authMethod?: string;
}
/** Optional host-owned credential accessor, passed on stream options. `get`
 *  seeds each call from the freshest token the host holds; `set` receives a
 *  credential the provider refreshed mid-call so it survives the call (and, via
 *  the host's persistence, later calls/processes). `ensureFresh` is awaited
 *  before the token is read, so a host that knows the expiry can refresh ahead
 *  of it instead of waiting for a 403. All are optional and best-effort — the
 *  provider falls back to the static `apiKey` and never lets an accessor
 *  failure fail the turn. */
export interface KiroCredentialAccessor {
    get?: () => string | undefined;
    set?: (creds: KiroCredentialLike) => void;
    ensureFresh?: () => Promise<void>;
}
/** streamKiro options: the shared `SimpleStreamOptions` plus Kiro's optional
 *  host credential accessor, so typed consumers can pass it without a cast. */
export interface KiroStreamOptions extends SimpleStreamOptions {
    credentialAccessor?: KiroCredentialAccessor;
}
/** Reset profile resolution state — exported for stream tests. */
export declare function resetProfileArnCache(resolved?: boolean): void;
interface TranscriptSystemMessage {
    role: "system";
    content: string | TextContent[];
    sections?: Record<string, string | null>;
    toolsAdded?: Tool[];
    toolsRemoved?: Array<{
        name: string;
    }>;
}
type ProviderContext = Context | {
    messages: Array<PiMessage | TranscriptSystemMessage>;
};
export declare function streamKiro(model: Model<Api>, context: ProviderContext, options?: KiroStreamOptions): AssistantMessageEventStream;
export declare function createKiroStream(usageTracking: KiroUsageTracking): (model: Model<Api>, context: ProviderContext, options?: KiroStreamOptions) => AssistantMessageEventStream;
export {};
