// ABOUTME: Adaptive spacing between Kiro request starts, shared by every stream
// ABOUTME: in the process and, through a small state file, across processes.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Rate limiting on Kiro is account-scoped, so a parallel fan-out competes with
 * itself: every concurrent stream in every session — and every pi process on the
 * machine — draws from the same budget. Retrying a rejected request recovers that
 * one call, but does nothing to stop the next burst from being rejected too.
 *
 * This pacer spaces out request *starts* — it never caps concurrency, so a long
 * stream cannot block a queued one for its whole duration. It stays fully out of
 * the way until the service actually complains: spacing is zero until a 429 is
 * observed, widens one step per rejection burst, and decays back to zero once the
 * service has been quiet. Cost on the happy path is one promise hop plus, at
 * most, one small file read every `sharedPollMs`.
 */
export const pacingConfig = {
  /** Spacing applied after the first observed rejection. */
  minSpacingMs: 200,
  /** Upper bound on spacing, regardless of how many rejections pile up. */
  maxSpacingMs: 4_000,
  /** Quiet period after which spacing is relaxed one step. */
  decayAfterMs: 30_000,
  /**
   * Window within which further rejections do not widen spacing again.
   *
   * A parallel fan-out is rejected all at once, so without this every request
   * in the burst would apply its own doubling and drive spacing to the ceiling
   * from a single event — punishing the next minute of work for one collision.
   * Coalescing makes one burst cost one step, so spacing tracks how often the
   * limit is hit rather than how wide the fan-out is.
   */
  penaltyCoalesceMs: 1_000,
  /**
   * How stale a dormant pacer's view of other processes may get. While spacing
   * is active the state file is consulted on every reservation; while dormant it
   * is polled at most this often, so an idle process pays almost nothing.
   */
  sharedPollMs: 2_000,
  /** Set false to disable pacing entirely (retry behavior is unaffected). */
  enabled: true,
  /** Set false to keep pacing state process-local. */
  shared: true,
};

/** Cross-process pacing state. All timestamps are epoch milliseconds. */
export interface PacingState {
  spacingMs: number;
  nextAllowedAt: number;
  lastPenaltyAt: number;
}

/** Storage for cross-process pacing state. Injectable for tests. */
export interface PacingStore {
  read(): PacingState | undefined;
  write(state: PacingState): void;
}

const DEFAULT_STATE_FILE = join(homedir(), ".pi", "logs", "kiro-pacing.json");

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * State file shared by every pi process for one user. Writes go through a
 * temp file plus rename so a concurrent reader never observes a partial object;
 * a lost update between two simultaneous writers only costs a little precision,
 * which retry already absorbs, so no lock is taken.
 */
export class FilePacingStore implements PacingStore {
  private dirReady = false;

  constructor(private readonly path: string = process.env.KIRO_PACING_STATE_FILE || DEFAULT_STATE_FILE) {}

  read(): PacingState | undefined {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return undefined;
      const { spacingMs, nextAllowedAt, lastPenaltyAt } = parsed as Record<string, unknown>;
      if (!isFiniteNumber(spacingMs) || !isFiniteNumber(nextAllowedAt) || !isFiniteNumber(lastPenaltyAt)) {
        return undefined;
      }
      return { spacingMs, nextAllowedAt, lastPenaltyAt };
    } catch {
      // Missing, unreadable, or corrupt: fall back to process-local pacing.
      return undefined;
    }
  }

  write(state: PacingState): void {
    try {
      if (!this.dirReady) {
        mkdirSync(dirname(this.path), { recursive: true });
        this.dirReady = true;
      }
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(state), "utf8");
      renameSync(tmp, this.path);
    } catch {
      // Best-effort: pacing degrades to process-local, never breaks a request.
    }
  }
}

function readEnvNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function applyEnvOverrides(): void {
  if (/^(0|off|false|no)$/i.test(process.env.KIRO_REQUEST_PACING ?? "")) pacingConfig.enabled = false;
  if (/^(0|off|false|no)$/i.test(process.env.KIRO_PACING_SHARED ?? "")) pacingConfig.shared = false;
  const min = readEnvNumber("KIRO_PACING_MIN_MS");
  if (min !== undefined) pacingConfig.minSpacingMs = min;
  const max = readEnvNumber("KIRO_PACING_MAX_MS");
  if (max !== undefined) pacingConfig.maxSpacingMs = max;
  const decay = readEnvNumber("KIRO_PACING_DECAY_MS");
  if (decay !== undefined) pacingConfig.decayAfterMs = decay;
  const coalesce = readEnvNumber("KIRO_PACING_COALESCE_MS");
  if (coalesce !== undefined) pacingConfig.penaltyCoalesceMs = coalesce;
  const poll = readEnvNumber("KIRO_PACING_POLL_MS");
  if (poll !== undefined) pacingConfig.sharedPollMs = poll;
}

applyEnvOverrides();

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export class RequestPacer {
  private spacing = 0;
  private nextAllowedAt = 0;
  private lastPenaltyAt = 0;
  /**
   * Negative infinity, not zero: a freshly started process must consult the
   * shared state on its very first request. That is the case this exists for —
   * a new pi process would otherwise burst into a limit its siblings just hit.
   */
  private lastSharedReadAt = Number.NEGATIVE_INFINITY;
  /**
   * Acquisitions run one at a time so concurrent callers observe each other's
   * reservation instead of all reading the same `nextAllowedAt`.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> = delay,
    private readonly store: PacingStore = new FilePacingStore(),
  ) {}

  /** Current spacing in milliseconds. Zero means pacing is dormant. */
  get spacingMs(): number {
    return this.spacing;
  }

  /** Wait until this process may start another Kiro request. */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    if (!pacingConfig.enabled) return;
    const run = this.queue.then(() => this.reserve(signal));
    // Keep the chain alive when a caller aborts while queued.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async reserve(signal?: AbortSignal): Promise<void> {
    this.adoptShared();
    this.decay();
    if (this.spacing <= 0) return;
    const now = this.now();
    const startAt = Math.max(now, this.nextAllowedAt);
    this.nextAllowedAt = startAt + this.spacing;
    this.publish();
    const wait = startAt - now;
    if (wait > 0) await this.sleep(wait, signal);
  }

  /** Record a rate rejection and widen spacing one step per burst. */
  penalize(): void {
    this.adoptShared(true);
    const now = this.now();
    // Same burst as the last rejection: keep the quiet timer fresh, but do not
    // widen again. `lastPenaltyAt > 0` distinguishes a first rejection at
    // clock-zero from a repeat.
    if (this.spacing > 0 && this.lastPenaltyAt > 0 && now - this.lastPenaltyAt < pacingConfig.penaltyCoalesceMs) {
      this.lastPenaltyAt = now;
      this.publish();
      return;
    }
    const { minSpacingMs, maxSpacingMs } = pacingConfig;
    this.spacing = Math.min(maxSpacingMs, this.spacing <= 0 ? minSpacingMs : this.spacing * 2);
    this.lastPenaltyAt = now;
    this.publish();
  }

  /**
   * Merge another process's state in. Spacing and reservations are taken as the
   * wider/later of the two: the limit is account-wide, so the most pessimistic
   * observer is the correct one.
   */
  private adoptShared(force = false): void {
    if (!pacingConfig.shared) return;
    const now = this.now();
    // While dormant, avoid a file read on every single request.
    if (!force && this.spacing <= 0 && now - this.lastSharedReadAt < pacingConfig.sharedPollMs) return;
    this.lastSharedReadAt = now;
    const shared = this.store.read();
    if (!shared) return;
    if (shared.spacingMs > this.spacing) this.spacing = Math.min(pacingConfig.maxSpacingMs, shared.spacingMs);
    if (shared.nextAllowedAt > this.nextAllowedAt) this.nextAllowedAt = shared.nextAllowedAt;
    if (shared.lastPenaltyAt > this.lastPenaltyAt) this.lastPenaltyAt = shared.lastPenaltyAt;
  }

  private publish(): void {
    if (!pacingConfig.shared) return;
    this.store.write({
      spacingMs: this.spacing,
      nextAllowedAt: this.nextAllowedAt,
      lastPenaltyAt: this.lastPenaltyAt,
    });
  }

  /** Drop back one step once the service has been quiet. */
  private decay(): void {
    if (this.spacing <= 0) return;
    const now = this.now();
    if (now - this.lastPenaltyAt < pacingConfig.decayAfterMs) return;
    const relaxed = this.spacing / 2;
    this.spacing = relaxed < pacingConfig.minSpacingMs ? 0 : relaxed;
    this.lastPenaltyAt = now;
    this.publish();
  }

  /** Test helper: forget all accumulated state. */
  reset(): void {
    this.spacing = 0;
    this.nextAllowedAt = 0;
    this.lastPenaltyAt = 0;
    this.lastSharedReadAt = Number.NEGATIVE_INFINITY;
    this.queue = Promise.resolve();
  }
}

/** Process-wide pacer, backed by the cross-process state file. */
export const requestPacer = new RequestPacer();
