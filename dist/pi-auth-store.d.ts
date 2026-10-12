import type { KiroCredentials } from "./oauth.js";
/**
 * Read pi's own persisted Kiro credential. Returns undefined when the file is
 * missing, unparseable, lacks a usable kiro entry, or the access token has
 * expired. Never logs file contents because auth.json holds many providers'
 * secrets.
 */
export declare function getPiHostKiroCredentials(agentDir?: string): KiroCredentials | undefined;
