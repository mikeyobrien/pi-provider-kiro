export interface KiroManagementAuth {
    accessToken: string;
    region: string;
}
export interface KiroCatalogModel {
    modelId: string;
    tokenLimits?: {
        maxInputTokens?: number;
        maxOutputTokens?: number;
        [key: string]: unknown;
    };
    additionalModelRequestFieldsSchema?: Record<string, unknown> | null;
    [key: string]: unknown;
}
export interface KiroListAvailableModelsResponse {
    models: KiroCatalogModel[];
    [key: string]: unknown;
}
export interface KiroGetUsageLimitsRequest {
    profileArn?: string;
    origin: "KIRO_CLI";
    resourceType: "CREDIT";
    isEmailRequired: false;
}
export declare class KiroManagementHttpError extends Error {
    readonly status: number;
    constructor(message: string, status: number);
}
export declare function resetKiroProfileArnCache(): void;
export declare function invalidateKiroProfileArn(auth: KiroManagementAuth): void;
export declare function resolveKiroProfileArn(auth: KiroManagementAuth, providedArn?: string): Promise<string>;
export declare function listAvailableModels(auth: KiroManagementAuth, profileArn: string): Promise<KiroListAvailableModelsResponse>;
export declare function fetchKiroModelCatalog(auth: KiroManagementAuth, providedProfileArn?: string): Promise<KiroListAvailableModelsResponse>;
export declare function getUsageLimits<TResponse>(auth: KiroManagementAuth, request: KiroGetUsageLimitsRequest): Promise<TResponse>;
