// Feature 1: Extension Registration
//
// Entry point that wires all features together via pi.registerProvider().

import type { Api, Model, OAuthCredentials, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSafeError } from "./debug.js";
import { getKiroEndpoints, resolveApiRegion } from "./endpoints.js";
import { getKiroCliCredentials, getKiroCliSocialToken } from "./kiro-cli.js";
import { getKiroIdeCredentials } from "./kiro-ide.js";
import { setExtensionContext } from "./login-ui.js";
import { getCachedModels, isCacheStale, type KiroModel, kiroModels, updateKiroModelsCache } from "./models.js";
import type { KiroCredentials } from "./oauth.js";
import { loginKiro, refreshKiroToken } from "./oauth.js";
import { streamKiro } from "./stream.js";
import { fetchKiroUsage } from "./usage.js";

export { resolveApiRegion } from "./endpoints.js";
export type { KiroStreamEvent } from "./event-parser.js";
export {
  isKiroToolStructureRule,
  KIRO_TOOL_STRUCTURE_RULES,
  KIRO_VALIDATION_MESSAGES,
  type KiroRepairResult,
  type KiroToolStructureRule,
  type KiroValidationError,
  type KiroValidationResult,
  KiroValidationRule,
  kiroConversationEntries,
  repairKiroConversation,
  SYNTHETIC_FAILED_TOOL_RESULT_TEXT,
  validateKiroConversation,
  validateKiroToolStructure,
} from "./history-validator.js";
export { KiroManagementHttpError } from "./management.js";
export { KIRO_MODEL_IDS, kiroModels, resolveKiroModel } from "./models.js";
// Kiro's own error vocabulary and the predicates this provider classifies it
// with. Published so consumers can interpret a reason code without an error
// instance in hand (e.g. a persisted log line) instead of hardcoding copies of
// the literals, which drift when the service adds a code.
export type { KiroReasonCode } from "./retry.js";
export {
  CAPACITY_PATTERN,
  isCapacityError,
  isNonRetryableBodyError,
  isTooBigError,
  KIRO_REASON_CODES,
  NON_RETRYABLE_BODY_PATTERNS,
  TOO_BIG_PATTERNS,
} from "./retry.js";
export { streamKiro } from "./stream.js";
export {
  EMPTY_CONTENT_PLACEHOLDER,
  type KiroHistoryEntry,
  type KiroToolResult,
  type KiroToolUse,
  type KiroUserInputMessage,
} from "./transform.js";

type KiroRefreshModelsContext = Omit<RefreshModelsContext, "credential" | "store"> & {
  credential?: RefreshModelsContext["credential"] | KiroCredentials;
  store?: RefreshModelsContext["store"];
};

type KiroRefreshCredential = KiroRefreshModelsContext["credential"];

/**
 * Local credential discovery. Every source is a file or environment read, so this
 * stays callable from the synchronous registration path.
 */
function resolveLocalCredential(): KiroRefreshCredential {
  const apiKey = process.env.KIRO_API_KEY;
  if (apiKey) return { type: "api_key", key: apiKey };
  try {
    return getKiroCliSocialToken() ?? getKiroCliCredentials() ?? getKiroIdeCredentials() ?? undefined;
  } catch (error) {
    console.warn(`[pi-provider-kiro] Failed to read local Kiro credentials: ${formatSafeError(error)}`);
    return undefined;
  }
}

function credentialRegion(credential: KiroRefreshCredential): string {
  const oauthCredential = credential && "access" in credential ? (credential as KiroCredentials) : undefined;
  return resolveApiRegion(oauthCredential?.region);
}

async function refreshCatalog(
  credential: KiroRefreshCredential,
  context: Pick<KiroRefreshModelsContext, "allowNetwork" | "force" | "signal">,
): Promise<KiroModel[]> {
  const oauthCredential = credential && "access" in credential ? (credential as KiroCredentials) : undefined;
  const apiKey =
    credential &&
    "type" in credential &&
    credential.type === "api_key" &&
    "key" in credential &&
    typeof credential.key === "string"
      ? credential.key
      : undefined;
  const accessToken =
    typeof oauthCredential?.access === "string" && oauthCredential.access ? oauthCredential.access : apiKey;
  const region = credentialRegion(credential);

  if (context.signal?.aborted) return [];

  if (accessToken && context.allowNetwork && (context.force || isCacheStale(region))) {
    try {
      await updateKiroModelsCache(accessToken, region, oauthCredential?.profileArn);
    } catch (error) {
      // Serve the cached catalog when discovery fails.
      console.warn(`[pi-provider-kiro] Failed to refresh Kiro model catalog in ${region}: ${formatSafeError(error)}`);
    }
  }

  return getCachedModels(region);
}

/**
 * Host-driven catalog refresh. `oauth.modifyModels` only projects whatever the
 * cache already holds, so this is the path that actually fetches when the host
 * asks for a refresh or the cache has gone stale. The composer re-applies
 * `modifyModels` on top of the returned list, so region/profileArn projection
 * still happens here.
 *
 * Persistence uses the existing Kiro management file cache
 * (`updateKiroModelsCache` / `~/.kiro-management-models-cache.json`) rather than
 * `context.store`, so oauth/stream and host refresh share one catalog source.
 */
function refreshKiroModels(context: KiroRefreshModelsContext): Promise<KiroModel[]> {
  return refreshCatalog(context.credential ?? resolveLocalCredential(), context);
}

let startupCatalogRefresh: Promise<void> = Promise.resolve();

/**
 * The post-registration startup work the factory deliberately does not await.
 * Exposed so tests can observe discovery without racing it.
 */
export function whenStartupCatalogSettled(): Promise<void> {
  return startupCatalogRefresh;
}

/**
 * Synchronous by contract. A host resolves `api: "kiro-api"` the moment a chat
 * starts, and not every host awaits an async extension factory before then, so
 * awaiting catalog discovery here left `kiro-api` unregistered while cached
 * models were still offered in the picker — the first user message then crashed
 * with `No API provider registered for api: kiro-api`. Discovery is kicked off
 * afterwards and the host's `refreshModels` hook fills in the rest.
 */
export default function (pi: ExtensionAPI) {
  // Capture ctx for the custom TUI login component
  pi.on("session_start", async (_event, ctx) => {
    setExtensionContext(ctx);
  });

  const credential = resolveLocalCredential();
  pi.registerProvider("kiro", {
    baseUrl: getKiroEndpoints("us-east-1").runtime,
    api: "kiro-api",
    apiKey: "$KIRO_API_KEY",
    models: kiroModels,
    refreshModels: refreshKiroModels,
    oauth: {
      // Name reflects all supported auth methods: AWS Builder ID, Google, GitHub
      name: "Kiro (Builder ID / Google / GitHub)",
      login: loginKiro,
      refreshToken: refreshKiroToken,
      getApiKey: (cred: OAuthCredentials) => cred.access,
      getCliCredentials: getKiroCliCredentials,
      modifyModels: (models: Model<Api>[], cred: OAuthCredentials) => {
        const apiRegion = resolveApiRegion((cred as KiroCredentials).region);
        const cachedKiro = getCachedModels(apiRegion);
        const nonKiro = models.filter((m: Model<Api>) => m.provider !== "kiro");
        const credentialProfileArn = (cred as KiroCredentials).profileArn;
        const modifiedKiro = cachedKiro.map((m: Model<Api>) => ({
          ...m,
          baseUrl: getKiroEndpoints(apiRegion).runtime,
          kiroRegion: apiRegion,
          ...(credentialProfileArn ? { kiroProfileArn: credentialProfileArn } : {}),
        }));

        return [...nonKiro, ...modifiedKiro];
      },
      fetchUsage: fetchKiroUsage,
      // biome-ignore lint/suspicious/noExplicitAny: ProviderConfig.oauth doesn't include getCliCredentials but OAuthProviderInterface does
    } as any,
    streamSimple: streamKiro,
  });

  startupCatalogRefresh = refreshCatalog(credential, { allowNetwork: true })
    .then(() => {})
    .catch((error) => {
      console.warn(`[pi-provider-kiro] Kiro startup catalog discovery failed: ${formatSafeError(error)}`);
    });
}
