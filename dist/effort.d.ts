import { type Api, type Model, type ThinkingLevel } from "@earendil-works/pi-ai";
export type KiroEffortField = "reasoning" | "output_config";
export interface KiroEffortConfig {
    field: KiroEffortField;
    values: readonly string[];
    summarizedThinking: boolean;
}
export type KiroAdditionalModelRequestFields = {
    reasoning: {
        effort: string;
    };
} | {
    output_config: {
        effort: string;
    };
    thinking: {
        type: "adaptive";
        display?: "summarized";
    };
};
type ModelWithKiroEffortMetadata = Model<Api> & {
    additionalModelRequestFieldsSchema?: unknown;
};
/** Derive Kiro's structured effort field and allowed enum from an authenticated catalog schema. */
export declare function deriveKiroEffort(schema: unknown): KiroEffortConfig | undefined;
/** Known-model compatibility used only before catalog schema metadata is available. */
export declare function fallbackKiroEffort(kiroModelId: string): KiroEffortConfig | undefined;
/** Prefer catalog schema; fall back only when it is absent. */
export declare function getKiroEffortConfig(schema: unknown, kiroModelId: string): KiroEffortConfig | undefined;
/** Map a canonical Pi level to a value that is present in the selected model's Kiro enum. */
export declare function mapPiLevelToKiroEffort(model: Model<Api>, level: ThinkingLevel, config: KiroEffortConfig): string | undefined;
/** Build the top-level Kiro runtime field for one requested Pi reasoning level. */
export declare function buildKiroAdditionalModelRequestFields(model: ModelWithKiroEffortMetadata, kiroModelId: string, level: ThinkingLevel | undefined): KiroAdditionalModelRequestFields | undefined;
export {};
