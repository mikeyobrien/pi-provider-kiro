export interface KiroEndpoints {
    region: string;
    management: string;
    runtime: string;
}
export declare function resolveApiRegion(ssoRegion: string | undefined): string;
export declare function getKiroEndpoints(region: string): KiroEndpoints;
/**
 * A Kiro profile is owned by one region and its ARN carries that region. The
 * runtime API rejects a profile ARN issued in another region with a generic
 * `Improperly formed request.`, so runtime host selection has to follow the
 * profile rather than the SSO-derived region: an Identity Center instance in
 * us-east-1 can own a profile in eu-central-1.
 */
export declare function getKiroRegionFromProfileArn(profileArn: string | undefined): string | undefined;
export declare function getKiroRegionFromEndpoint(endpoint: string): string | undefined;
