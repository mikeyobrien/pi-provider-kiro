import type { Model } from "@earendil-works/pi-ai";
import { type KiroEffortConfig } from "./effort.js";
import { type KiroCatalogModel } from "./management.js";
export { resolveApiRegion } from "./endpoints.js";
export declare const KIRO_MANAGEMENT_CACHE_VERSION = 2;
export declare const KIRO_MANAGEMENT_CACHE_SOURCE = "kiro-management";
export declare const KIRO_MANAGEMENT_CACHE_PATH: string;
export declare const LEGACY_HOME_CACHE_PATH: string;
type KiroTokenLimits = NonNullable<KiroCatalogModel["tokenLimits"]>;
/** Effort rungs omp's ThinkingConfig schema accepts. */
declare const OMP_THINKING_EFFORTS: readonly ["minimal", "low", "medium", "high", "xhigh", "max"];
export type KiroThinkingEffort = (typeof OMP_THINKING_EFFORTS)[number];
export type KiroThinkingConfig = {
    mode: "effort";
    efforts: readonly KiroThinkingEffort[];
    /** Kiro can return a summarized thinking block for this model. */
    supportsDisplay?: boolean;
};
export interface KiroModel extends Model<"kiro-api"> {
    /** Exact model ID returned by the Kiro management catalog. */
    kiroModelId: string;
    /** Catalog metadata consumed by request-time effort handling. */
    additionalModelRequestFieldsSchema?: Record<string, unknown>;
    tokenLimits?: KiroTokenLimits;
    firstTokenTimeout?: number;
    /** Senpi should trust Kiro's native tool-use events instead of parsing XML-like text. */
    recoverTextToolCalls?: boolean;
    kiroRegion?: string;
    /** Credential-scoped profile ARN attached only to the in-memory model projection. */
    kiroProfileArn?: string;
    /** omp >=13.9.3 reads this; pi reads thinkingLevelMap. Emit both. */
    thinking?: KiroThinkingConfig;
}
/**
 * Bootstrap models carry no catalog schema, so their ladder comes from the same
 * `getKiroEffortConfig` fallback the request path uses. Deriving here instead of
 * hardcoding per-model literals keeps one source of truth: `effort.ts` decides
 * which model gets which rungs, and discovery overwrites this once it runs.
 */
export declare const kiroModels: KiroModel[];
/** Exact service IDs known from either the bootstrap list or a valid management cache. */
export declare const KIRO_MODEL_IDS: Set<string>;
/**
 * omp >=13.9.3 reads `thinking`; pi reads `thinkingLevelMap`. Rungs are filtered
 * through omp's own enum because Kiro may report a value outside it (`none`).
 * `supportsDisplay` comes from the schema's `thinking.display` enum, which omp
 * never infers for `kiro-api` — only for native anthropic/bedrock APIs.
 */
export declare function deriveThinkingConfig(config: KiroEffortConfig | undefined): KiroThinkingConfig | undefined;
/** Map an authenticated management catalog into Pi models without discarding fresh metadata for bootstrap IDs. */
export declare function mapKiroCatalogModels(catalogModels: KiroCatalogModel[], region: string): KiroModel[];
export declare function loadCachedModelIds(): void;
/** Return the authenticated regional catalog, or the static list only as a pre-discovery bootstrap. */
export declare function getCachedModels(region: string): KiroModel[];
export declare function isCacheStale(region: string): boolean;
export declare function updateKiroModelsCache(accessToken: string, region: string, profileArn?: string): Promise<void>;
export declare function resolveKiroModel(modelId: string, exactKiroModelId?: string): string;
