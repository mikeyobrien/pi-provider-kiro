// ABOUTME: Client for Kiro's cloud memory API on the Kiro web BFF (KiroWebBearerService, Smithy RPCv2 CBOR).
// ABOUTME: Exposes exactly the four bearer-surface operations: PutMemory, GetMemory, DeleteMemory, ListMemoryChanges.

import { cbor } from "@smithy/core/cbor";
import { redactSensitiveText } from "./debug.js";
import { BUILDER_ID_PROFILE_ARN, isApiKey, type KiroAuthMethod } from "./oauth.js";
import { isExternalIdpAccessToken } from "./token-type.js";

/**
 * Production BFF. Kiro's own clients (kiro-cli `launch.rs`) default here and
 * hand the endpoint to Kiro Agent as `KIRO_MEMORY_SYNC_ENDPOINT`.
 */
export const KIRO_MEMORY_DEFAULT_ENDPOINT = "https://app.kiro.dev";

/** Overrides the BFF endpoint. Must name a trusted Kiro host or the local loopback. */
export const KIRO_MEMORY_ENDPOINT_ENV = "KIRO_MEMORY_ENDPOINT";

/**
 * The partition Kiro Agent keeps every memory in. Memories written here are
 * the ones Kiro's own clients sync; another namespace is a separate partition
 * of the same user's memories that Kiro clients never read.
 */
export const KIRO_MEMORY_DEFAULT_NAMESPACE = "KNOWLEDGE";

/**
 * Hosts the bearer token may be sent to, matching kiro-cli's
 * `TRUSTED_BFF_HOSTS`: the token is a user credential, so an override from a
 * stray environment variable must not name an arbitrary destination.
 */
const TRUSTED_MEMORY_HOSTS: ReadonlySet<string> = new Set(["app.kiro.dev", "gamma.app.kiro.dev", "beta.app.kiro.dev"]);

const SERVICE_PATH = "/service/KiroWebBearerService/operation/";

/** The memory kinds the service models. Absent on write means SEMANTIC. */
export const KIRO_MEMORY_TYPES = ["SEMANTIC", "USER_PREFERENCE", "SUMMARIZATION"] as const;
export type KiroMemoryType = (typeof KIRO_MEMORY_TYPES)[number];

/** Lifecycle status. Reads return active memories; a deleted memory is retired. */
export type KiroMemoryStatus = "active" | "retired";

export type KiroMemoryOperation = "PutMemory" | "GetMemory" | "DeleteMemory" | "ListMemoryChanges";

/**
 * Bounds from the service's Smithy model, as Kiro Agent's generated client carries them.
 * Checked before sending so a bad value fails locally with the field named,
 * instead of a round trip that answers a generic 400.
 */
export const KIRO_MEMORY_LIMITS = Object.freeze({
  idMaxLength: 128,
  namespaceMaxLength: 256,
  contentMaxLength: 65_536,
  textMaxLength: 4_096,
  labelMaxLength: 256,
  scopeMaxLength: 256,
  maxScopes: 50,
  maxMetadataEntries: 50,
  metadataKeyMaxLength: 256,
  metadataValueMaxLength: 4_096,
  retiredReasonMaxLength: 256,
  versionTokenMaxLength: 64,
  maxResultsPerChangePage: 500,
});

/** A memory as GetMemory returns it. */
export interface KiroMemory {
  memoryId: string;
  namespace: string;
  content: string;
  status: KiroMemoryStatus;
  createdAt: number;
  updatedAt: number;
  title?: string;
  summary?: string;
  /** The service may return a type newer than this client knows, so it is kept as a string. */
  memoryType?: string;
  sessionId?: string;
  scopes?: string[];
  topic?: string;
  metadata?: Record<string, string>;
}

/** A memory as a change listing carries it: no namespace, status, createdAt or sessionId. */
export interface KiroMemoryChangeEntry {
  memoryId: string;
  updatedAt: number;
  content?: string;
  title?: string;
  summary?: string;
  memoryType?: string;
  scopes?: string[];
  topic?: string;
  metadata?: Record<string, string>;
}

export interface KiroMemoryChange {
  type: "ADD" | "UPDATE" | "REMOVE";
  memoryId: string;
  /** updatedAt for ADD/UPDATE, the deletion time for REMOVE. */
  changedAt: number;
  /** Present for ADD/UPDATE, absent for REMOVE. */
  memory?: KiroMemoryChangeEntry;
}

export interface KiroPutMemoryInput {
  content: string;
  /**
   * Stable id. Repeating a put with the same id replaces that memory. Omit to
   * have the service mint one. An id whose memory was deleted cannot be reused
   * (the service answers 409 for it permanently).
   */
  memoryId?: string;
  title?: string;
  summary?: string;
  memoryType?: KiroMemoryType;
  scopes?: readonly string[];
  topic?: string;
  sessionId?: string;
  metadata?: Readonly<Record<string, string>>;
  namespace?: string;
}

export interface KiroListMemoryChangesInput {
  namespace?: string;
  /** The version token the caller holds. Omit for a full listing of every active memory. */
  from?: string;
  /** Target version token, or "latest" (the default). */
  to?: string;
  nextToken?: string;
  maxResults?: number;
}

export interface KiroMemoryChangePage {
  namespace: string;
  from?: string;
  /** Identical on every page of one listing. Keep it as the next `from` once the last page is read. */
  to: string;
  changes: KiroMemoryChange[];
  nextToken?: string;
}

/**
 * What a failed memory call means for the caller. Named for what to do next,
 * mirroring Kiro Agent's `MemoryServiceFailure` with the cases a direct client
 * also meets:
 *
 * - `forbidden`: memory is closed for this user (the `enableRemoteMemorySync`
 *   rollout does not include them, or the account is suspended). Retrying will
 *   not help.
 * - `unauthorized`: the token was rejected or no profile resolved. Refresh the
 *   credential and retry.
 * - `notFound`: the memory does not exist, or (for a listing) the user has never
 *   written a memory or `to` names a version that does not exist yet.
 * - `gone`: the listing's version token was pruned. Drop it and list from the start.
 * - `conflict`: the id names a deleted memory and cannot be reused.
 * - `invalid`: the request itself was rejected, locally or by the service. The
 *   same request gets the same answer.
 * - `throttled`: retry later.
 * - `unavailable`: network failure, server fault, or an answer this client cannot read. Retry later.
 */
export type KiroMemoryErrorKind =
  | "forbidden"
  | "unauthorized"
  | "notFound"
  | "gone"
  | "conflict"
  | "invalid"
  | "throttled"
  | "unavailable";

/**
 * A failed memory call. `message` names the operation, the HTTP status and the
 * service's error type, and the service's message after redaction. It never
 * carries the bearer token or memory content.
 */
export class KiroMemoryError extends Error {
  constructor(
    message: string,
    readonly operation: KiroMemoryOperation,
    readonly kind: KiroMemoryErrorKind,
    /** HTTP status, or undefined when no response arrived or the request failed validation locally. */
    readonly status?: number,
    /** The service's error shape name without its namespace, e.g. `ForbiddenException`. */
    readonly errorType?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "KiroMemoryError";
  }
}

/** The credential each memory request is sent with. */
export interface KiroMemoryCredential {
  /** Kiro bearer access token (OAuth access token or a `ksk_` API key). */
  access: string;
  /** Kiro profile ARN. The service resolves the user from it for a person's sign-in. */
  profileArn?: string;
  /** The provider's auth method, used to name the sign-in's identity provider. */
  authMethod?: KiroAuthMethod | string;
  /** IAM Identity Center start URL, distinguishing Builder ID from an organization's IdC. */
  startUrl?: string;
  /**
   * Social sign-in provider for a desktop token (`Google` or `Github`). kiro-cli
   * records it on its social token; the provider's own desktop credential does not.
   */
  socialProvider?: string;
}

export interface KiroMemoryClientOptions {
  /**
   * Returns the credential to send. Called once per request so a refreshed
   * token is picked up. Reject or return undefined when no credential exists.
   */
  getCredential: () => Promise<KiroMemoryCredential | undefined> | KiroMemoryCredential | undefined;
  /** BFF endpoint. Defaults to `$KIRO_MEMORY_ENDPOINT`, then {@link KIRO_MEMORY_DEFAULT_ENDPOINT}. */
  endpoint?: string;
  /** Namespace used when a call names none. Defaults to {@link KIRO_MEMORY_DEFAULT_NAMESPACE}. */
  namespace?: string;
  /** Injected for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface KiroMemoryClient {
  readonly endpoint: string;
  readonly namespace: string;
  /** Create a memory, or replace the memory with `input.memoryId`. Resolves to the memory's id. */
  put(input: KiroPutMemoryInput, signal?: AbortSignal): Promise<{ memoryId: string }>;
  /** Read one active memory with its content. Rejects with kind `notFound` when absent or deleted. */
  get(memoryId: string, options?: { namespace?: string; signal?: AbortSignal }): Promise<KiroMemory>;
  /** Delete (retire) a memory. Succeeds when the memory is already gone. */
  delete(
    memoryId: string,
    options?: { namespace?: string; retiredReason?: string; signal?: AbortSignal },
  ): Promise<void>;
  /** One page of the change stream. */
  listChanges(input?: KiroListMemoryChangesInput, signal?: AbortSignal): Promise<KiroMemoryChangePage>;
  /**
   * Every active memory in the namespace, by paging a full change listing.
   * Returns an empty list when the user has never written a memory. `version`
   * is the listing's `to`, usable as `from` for a later incremental listing.
   */
  listAll(options?: { namespace?: string; signal?: AbortSignal }): Promise<{
    memories: KiroMemoryChangeEntry[];
    version?: string;
  }>;
}

/**
 * Resolve and vet the BFF endpoint: https to a trusted Kiro host, or http(s)
 * to the local loopback. Throws a `KiroMemoryError` of kind `invalid` for
 * anything else, naming only the scheme and host so a credential-bearing URL
 * is never echoed.
 */
export function resolveKiroMemoryEndpoint(explicit?: string): string {
  const raw = (explicit ?? process.env[KIRO_MEMORY_ENDPOINT_ENV])?.trim() || KIRO_MEMORY_DEFAULT_ENDPOINT;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new KiroMemoryError("Kiro memory endpoint is not a valid URL", "PutMemory", "invalid");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const allowed =
    (url.protocol === "https:" && (loopback || TRUSTED_MEMORY_HOSTS.has(url.hostname))) ||
    (url.protocol === "http:" && loopback);
  if (!allowed) {
    throw new KiroMemoryError(
      `Kiro memory endpoint ${url.protocol}//${url.hostname} is not a trusted Kiro host or the local loopback`,
      "PutMemory",
      "invalid",
    );
  }
  return url.origin;
}

/**
 * The `X-Kiro-Idp` value for a person's sign-in, from the BFF's allowlist
 * (Google | Github | BuilderId | AWSIdC | ExternalOIDC). The memory operations
 * require it (the service answers 401 "Identity provider is required" without
 * it), so a sign-in whose
 * provider cannot be named yields undefined and the call is refused locally
 * rather than sent. Undefined also for an API key, which declares
 * `TokenType: API_KEY` instead. Internal Amazon IdC declares `AWSIdC`: the BFF
 * answers 400 to `Internal`.
 */
export function kiroMemoryIdpHeader(credential: KiroMemoryCredential): string | undefined {
  if (isApiKey(credential.access)) return undefined;
  if (credential.authMethod === "external-idp" || isExternalIdpAccessToken(credential.access)) return "ExternalOIDC";
  if (credential.authMethod === "desktop") {
    const provider = credential.socialProvider?.toLowerCase();
    if (provider === "google") return "Google";
    if (provider === "github") return "Github";
    return undefined;
  }
  if (credential.authMethod === "idc" || credential.authMethod === undefined) {
    const builderId =
      credential.profileArn === BUILDER_ID_PROFILE_ARN || credential.startUrl === "https://view.awsapps.com/start";
    return builderId ? "BuilderId" : "AWSIdC";
  }
  return undefined;
}

function identityHeaders(credential: KiroMemoryCredential): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${credential.access}` };
  if (isApiKey(credential.access)) {
    headers.TokenType = "API_KEY";
    return headers;
  }
  const idp = kiroMemoryIdpHeader(credential);
  if (idp) headers["X-Kiro-Idp"] = idp;
  if (idp === "ExternalOIDC") headers.TokenType = "EXTERNAL_IDP";
  if (credential.profileArn) headers["X-Kiro-Profile-Arn"] = credential.profileArn;
  return headers;
}

// --- local validation -------------------------------------------------------

const ID_PATTERN = /^[A-Za-z0-9-]+$/;

function invalid(operation: KiroMemoryOperation, detail: string): KiroMemoryError {
  return new KiroMemoryError(`Kiro memory ${operation} rejected locally: ${detail}`, operation, "invalid");
}

function checkId(operation: KiroMemoryOperation, field: string, value: unknown, max: number): void {
  if (typeof value !== "string" || value.length === 0) throw invalid(operation, `${field} is required`);
  if (value.length > max) throw invalid(operation, `${field} exceeds ${max} characters`);
  if (!ID_PATTERN.test(value)) throw invalid(operation, `${field} may contain only ASCII letters, digits and '-'`);
}

function checkText(operation: KiroMemoryOperation, field: string, value: unknown, max: number): void {
  if (value === undefined) return;
  if (typeof value !== "string") throw invalid(operation, `${field} must be a string`);
  if (value.length > max) throw invalid(operation, `${field} exceeds ${max} characters`);
}

function validatePut(input: KiroPutMemoryInput, namespace: string): void {
  const op = "PutMemory";
  const L = KIRO_MEMORY_LIMITS;
  checkId(op, "namespace", namespace, L.namespaceMaxLength);
  if (typeof input?.content !== "string" || input.content.length === 0) throw invalid(op, "content is required");
  if (input.content.length > L.contentMaxLength) throw invalid(op, `content exceeds ${L.contentMaxLength} characters`);
  if (input.memoryId !== undefined) checkId(op, "memoryId", input.memoryId, L.idMaxLength);
  checkText(op, "title", input.title, L.textMaxLength);
  checkText(op, "summary", input.summary, L.textMaxLength);
  checkText(op, "topic", input.topic, L.labelMaxLength);
  checkText(op, "sessionId", input.sessionId, L.labelMaxLength);
  if (input.memoryType !== undefined && !KIRO_MEMORY_TYPES.includes(input.memoryType)) {
    throw invalid(op, `memoryType must be one of ${KIRO_MEMORY_TYPES.join(", ")}`);
  }
  if (input.scopes !== undefined) {
    if (!Array.isArray(input.scopes)) throw invalid(op, "scopes must be an array of strings");
    if (input.scopes.length > L.maxScopes) throw invalid(op, `scopes holds more than ${L.maxScopes} entries`);
    for (const scope of input.scopes) checkText(op, "scope", scope, L.scopeMaxLength);
  }
  if (input.metadata !== undefined) {
    if (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata)) {
      throw invalid(op, "metadata must be an object of string values");
    }
    const entries = Object.entries(input.metadata);
    if (entries.length > L.maxMetadataEntries)
      throw invalid(op, `metadata holds more than ${L.maxMetadataEntries} entries`);
    for (const [key, value] of entries) {
      checkText(op, "metadata key", key, L.metadataKeyMaxLength);
      if (typeof value !== "string") throw invalid(op, "metadata values must be strings");
      checkText(op, "metadata value", value, L.metadataValueMaxLength);
    }
  }
}

// --- wire --------------------------------------------------------------------

/** Drop undefined members: the CBOR encoder refuses them, and an absent member is how Smithy omits a field. */
function compact(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

/** Map an error response to a kind. The modeled error name wins; the status is the fallback. */
function errorKind(status: number, errorType: string | undefined): KiroMemoryErrorKind {
  switch (errorType) {
    case "ForbiddenException":
    case "AccountSuspendedException":
      return "forbidden";
    case "UnauthorizedException":
      return "unauthorized";
    case "ResourceNotFoundException":
      return "notFound";
    case "MemoryVersionGoneException":
      return "gone";
    case "ConflictException":
      return "conflict";
    case "BadRequestException":
    case "ValidationException":
      return "invalid";
    case "ThrottlingException":
      return "throttled";
  }
  if (status === 401) return "unauthorized";
  if (status === 403 || status === 423) return "forbidden";
  if (status === 404) return "notFound";
  if (status === 409) return "conflict";
  if (status === 410) return "gone";
  if (status === 429) return "throttled";
  if (status === 400) return "invalid";
  return "unavailable";
}

/** `com.amazon.kirowebportalservice#ForbiddenException` → `ForbiddenException`. */
function shortErrorType(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const name = raw.split("#").pop()?.split(":")[0];
  return name || undefined;
}

function decodeBody(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) return {};
  return cbor.deserialize(bytes);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** CBOR may decode an epoch-millis Long as a bigint; normalize to number. */
function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function withOptional<T extends object>(target: T, fields: Record<string, unknown>): T {
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) (target as Record<string, unknown>)[key] = value;
  }
  return target;
}

function unreadable(operation: KiroMemoryOperation, what: string): KiroMemoryError {
  return new KiroMemoryError(`Kiro memory ${operation} returned ${what}`, operation, "unavailable");
}

function parseMemory(operation: KiroMemoryOperation, raw: unknown): KiroMemory {
  const record = asRecord(raw);
  const memoryId = optionalString(record?.memoryId);
  const content = optionalString(record?.content);
  const createdAt = toNumber(record?.createdAt);
  const updatedAt = toNumber(record?.updatedAt);
  if (!record || !memoryId || content === undefined || createdAt === undefined || updatedAt === undefined) {
    throw unreadable(operation, "a memory this client cannot read");
  }
  return withOptional<KiroMemory>(
    {
      memoryId,
      namespace: optionalString(record.namespace) ?? "",
      content,
      status: record.status === "retired" ? "retired" : "active",
      createdAt,
      updatedAt,
    },
    {
      title: optionalString(record.title),
      summary: optionalString(record.summary),
      memoryType: optionalString(record.memoryType),
      sessionId: optionalString(record.sessionId),
      scopes: stringArray(record.scopes),
      topic: optionalString(record.topic),
      metadata: stringMap(record.metadata),
    },
  );
}

function parseChange(raw: unknown): KiroMemoryChange | undefined {
  const record = asRecord(raw);
  const type = record?.type;
  const memoryId = optionalString(record?.memoryId);
  const changedAt = toNumber(record?.changedAt);
  if (!record || (type !== "ADD" && type !== "UPDATE" && type !== "REMOVE") || !memoryId || changedAt === undefined) {
    return undefined;
  }
  const change: KiroMemoryChange = { type, memoryId, changedAt };
  const entry = asRecord(record.memory);
  if (entry) {
    change.memory = withOptional<KiroMemoryChangeEntry>(
      { memoryId: optionalString(entry.memoryId) ?? memoryId, updatedAt: toNumber(entry.updatedAt) ?? changedAt },
      {
        content: optionalString(entry.content),
        title: optionalString(entry.title),
        summary: optionalString(entry.summary),
        memoryType: optionalString(entry.memoryType),
        scopes: stringArray(entry.scopes),
        topic: optionalString(entry.topic),
        metadata: stringMap(entry.metadata),
      },
    );
  }
  return change;
}

function parseChangePage(raw: unknown): KiroMemoryChangePage {
  const op = "ListMemoryChanges";
  const record = asRecord(raw);
  const to = optionalString(record?.to);
  if (!record || !to || !Array.isArray(record.changes)) throw unreadable(op, "a change page this client cannot read");
  const changes: KiroMemoryChange[] = [];
  for (const entry of record.changes) {
    const change = parseChange(entry);
    // One unreadable change fails the page: a caller that kept `to` would never see it again.
    if (!change) throw unreadable(op, "a change this client cannot read");
    changes.push(change);
  }
  return withOptional<KiroMemoryChangePage>(
    { namespace: optionalString(record.namespace) ?? "", to, changes },
    { from: optionalString(record.from), nextToken: optionalString(record.nextToken) },
  );
}

/** Build a memory client. Nothing is sent until a method is called. */
export function createKiroMemoryClient(options: KiroMemoryClientOptions): KiroMemoryClient {
  const endpoint = resolveKiroMemoryEndpoint(options.endpoint);
  const defaultNamespace = options.namespace ?? KIRO_MEMORY_DEFAULT_NAMESPACE;
  const fetchImpl = options.fetch ?? fetch;

  async function call(
    operation: KiroMemoryOperation,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let credential: KiroMemoryCredential | undefined;
    try {
      credential = await options.getCredential();
    } catch (error) {
      throw new KiroMemoryError(
        `Kiro memory ${operation} has no usable Kiro credential`,
        operation,
        "unauthorized",
        undefined,
        undefined,
        {
          cause: error,
        },
      );
    }
    if (!credential?.access) {
      throw new KiroMemoryError(
        `Kiro memory ${operation} has no Kiro credential; log in first`,
        operation,
        "unauthorized",
      );
    }
    if (!isApiKey(credential.access) && kiroMemoryIdpHeader(credential) === undefined) {
      throw new KiroMemoryError(
        `Kiro memory ${operation} cannot name the sign-in's identity provider; set socialProvider for a Google/GitHub sign-in`,
        operation,
        "unauthorized",
      );
    }

    let response: Response;
    try {
      response = await fetchImpl(`${endpoint}${SERVICE_PATH}${operation}`, {
        method: "POST",
        headers: {
          "smithy-protocol": "rpc-v2-cbor",
          "Content-Type": "application/cbor",
          Accept: "application/cbor",
          ...identityHeaders(credential),
        },
        body: cbor.serialize(compact(body)) as Uint8Array<ArrayBuffer>,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new KiroMemoryError(
        `Kiro memory ${operation} request failed`,
        operation,
        "unavailable",
        undefined,
        undefined,
        {
          cause: error,
        },
      );
    }

    let decoded: unknown;
    let decodeFailed = false;
    try {
      decoded = decodeBody(new Uint8Array(await response.arrayBuffer()));
    } catch {
      decodeFailed = true;
    }

    if (!response.ok) {
      const errorBody = asRecord(decoded);
      const errorType = shortErrorType(errorBody?.__type) ?? shortErrorType(response.headers.get("x-amzn-errortype"));
      const serviceMessage = optionalString(errorBody?.message) ?? optionalString(errorBody?.Message);
      const detail = [errorType, serviceMessage ? redactSensitiveText(serviceMessage) : undefined]
        .filter(Boolean)
        .join(": ");
      throw new KiroMemoryError(
        `Kiro memory ${operation} failed: ${response.status}${detail ? ` ${detail}` : ""}`,
        operation,
        errorKind(response.status, errorType),
        response.status,
        errorType,
      );
    }
    if (decodeFailed) throw unreadable(operation, "a response that is not CBOR");
    return decoded;
  }

  const client: KiroMemoryClient = {
    endpoint,
    namespace: defaultNamespace,

    async put(input, signal) {
      const namespace = input?.namespace ?? defaultNamespace;
      validatePut(input, namespace);
      const raw = asRecord(
        await call(
          "PutMemory",
          {
            namespace,
            content: input.content,
            clientToken: input.memoryId,
            title: input.title,
            summary: input.summary,
            memoryType: input.memoryType,
            scopes: input.scopes ? [...input.scopes] : undefined,
            topic: input.topic,
            sessionId: input.sessionId,
            metadata: input.metadata ? { ...input.metadata } : undefined,
          },
          signal,
        ),
      );
      const memoryId = optionalString(raw?.memoryId);
      if (!memoryId) throw unreadable("PutMemory", "no memory id");
      return { memoryId };
    },

    async get(memoryId, opts = {}) {
      const namespace = opts.namespace ?? defaultNamespace;
      checkId("GetMemory", "namespace", namespace, KIRO_MEMORY_LIMITS.namespaceMaxLength);
      checkId("GetMemory", "memoryId", memoryId, KIRO_MEMORY_LIMITS.idMaxLength);
      const raw = asRecord(await call("GetMemory", { namespace, memoryId }, opts.signal));
      return parseMemory("GetMemory", raw?.memory);
    },

    async delete(memoryId, opts = {}) {
      const namespace = opts.namespace ?? defaultNamespace;
      checkId("DeleteMemory", "namespace", namespace, KIRO_MEMORY_LIMITS.namespaceMaxLength);
      checkId("DeleteMemory", "memoryId", memoryId, KIRO_MEMORY_LIMITS.idMaxLength);
      if (
        opts.retiredReason !== undefined &&
        (opts.retiredReason.length === 0 || opts.retiredReason.length > KIRO_MEMORY_LIMITS.retiredReasonMaxLength)
      ) {
        throw invalid(
          "DeleteMemory",
          `retiredReason must be 1-${KIRO_MEMORY_LIMITS.retiredReasonMaxLength} characters`,
        );
      }
      try {
        await call("DeleteMemory", { namespace, memoryId, retiredReason: opts.retiredReason }, opts.signal);
      } catch (error) {
        // The model documents delete as idempotent; a 404 still means the memory is gone.
        if (error instanceof KiroMemoryError && error.kind === "notFound") return;
        throw error;
      }
    },

    async listChanges(input = {}, signal) {
      const namespace = input.namespace ?? defaultNamespace;
      const op = "ListMemoryChanges";
      checkId(op, "namespace", namespace, KIRO_MEMORY_LIMITS.namespaceMaxLength);
      checkText(op, "from", input.from, KIRO_MEMORY_LIMITS.versionTokenMaxLength);
      checkText(op, "to", input.to, KIRO_MEMORY_LIMITS.versionTokenMaxLength);
      if (input.from === "" || input.to === "") throw invalid(op, "from and to must not be empty");
      if (
        input.maxResults !== undefined &&
        (!Number.isInteger(input.maxResults) ||
          input.maxResults < 1 ||
          input.maxResults > KIRO_MEMORY_LIMITS.maxResultsPerChangePage)
      ) {
        throw invalid(op, `maxResults must be an integer from 1 to ${KIRO_MEMORY_LIMITS.maxResultsPerChangePage}`);
      }
      return parseChangePage(
        await call(
          op,
          { namespace, from: input.from, to: input.to, nextToken: input.nextToken, maxResults: input.maxResults },
          signal,
        ),
      );
    },

    async listAll(opts = {}) {
      const byId = new Map<string, KiroMemoryChangeEntry>();
      let nextToken: string | undefined;
      let version: string | undefined;
      try {
        do {
          const page = await client.listChanges({ namespace: opts.namespace, nextToken }, opts.signal);
          version = page.to;
          for (const change of page.changes) {
            if (change.type === "REMOVE") byId.delete(change.memoryId);
            else if (change.memory) byId.set(change.memoryId, change.memory);
          }
          nextToken = page.nextToken;
        } while (nextToken);
      } catch (error) {
        // A full listing answers 404 on its first page until the user's first write creates the view.
        if (error instanceof KiroMemoryError && error.kind === "notFound" && version === undefined) {
          return { memories: [] };
        }
        throw error;
      }
      return withOptional({ memories: [...byId.values()] }, { version });
    },
  };
  return client;
}
