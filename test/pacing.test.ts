// ABOUTME: Tests for the adaptive request pacer used to avoid repeat 429s.
// ABOUTME: Uses an injected clock and sleep so no test waits on real time.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilePacingStore, type PacingState, type PacingStore, pacingConfig, RequestPacer } from "../src/pacing.js";

class MemoryStore implements PacingStore {
  state: PacingState | undefined;
  reads = 0;
  writes = 0;

  read(): PacingState | undefined {
    this.reads++;
    return this.state;
  }

  write(state: PacingState): void {
    this.writes++;
    this.state = { ...state };
  }
}

interface Harness {
  pacer: RequestPacer;
  /** Milliseconds each acquire() was asked to wait, in completion order. */
  waits: number[];
  store: MemoryStore;
  advance: (ms: number) => void;
  now: () => number;
}

function harness(): Harness {
  let now = 1_000;
  const waits: number[] = [];
  const store = new MemoryStore();
  const pacer = new RequestPacer(
    () => now,
    async (ms, signal) => {
      if (signal?.aborted) throw signal.reason;
      waits.push(ms);
      now += ms;
    },
    store,
  );
  return {
    pacer,
    waits,
    store,
    advance: (ms) => {
      now += ms;
    },
    now: () => now,
  };
}

const defaults = { ...pacingConfig };

afterEach(() => {
  Object.assign(pacingConfig, defaults);
});

describe("RequestPacer", () => {
  it("is dormant until a rejection is observed", async () => {
    const { pacer, waits } = harness();
    await pacer.acquire();
    await pacer.acquire();
    await pacer.acquire();
    expect(waits).toEqual([]);
    expect(pacer.spacingMs).toBe(0);
  });

  it("starts spacing at minSpacingMs after the first rejection", async () => {
    const { pacer, waits } = harness();
    pacer.penalize();
    expect(pacer.spacingMs).toBe(pacingConfig.minSpacingMs);
    // First acquire reserves the current instant, so it does not wait.
    await pacer.acquire();
    expect(waits).toEqual([]);
    // The next one waits out the reservation.
    await pacer.acquire();
    expect(waits).toEqual([pacingConfig.minSpacingMs]);
  });

  it("doubles spacing on each further rejection, capped at maxSpacingMs", () => {
    const { pacer, advance } = harness();
    pacingConfig.minSpacingMs = 200;
    pacingConfig.maxSpacingMs = 800;
    const step = () => {
      advance(pacingConfig.penaltyCoalesceMs);
      pacer.penalize();
    };
    pacer.penalize();
    expect(pacer.spacingMs).toBe(200);
    step();
    expect(pacer.spacingMs).toBe(400);
    step();
    expect(pacer.spacingMs).toBe(800);
    step();
    expect(pacer.spacingMs).toBe(800);
  });

  it("counts one burst of simultaneous rejections as a single step", () => {
    const { pacer, advance } = harness();
    pacingConfig.minSpacingMs = 200;
    // A 100-way fan-out rejected at once must not drive spacing to the ceiling.
    for (let i = 0; i < 100; i++) pacer.penalize();
    expect(pacer.spacingMs).toBe(200);

    // A rejection in a later window still escalates.
    advance(pacingConfig.penaltyCoalesceMs);
    pacer.penalize();
    expect(pacer.spacingMs).toBe(400);
  });

  it("keeps the quiet timer fresh while a burst is still arriving", async () => {
    const { pacer, advance } = harness();
    pacer.penalize();
    // Rejections keep coming just under the coalesce window for a long stretch.
    for (let i = 0; i < 50; i++) {
      advance(pacingConfig.penaltyCoalesceMs - 1);
      pacer.penalize();
    }
    // Decay must not fire despite total elapsed time exceeding decayAfterMs.
    await pacer.acquire();
    expect(pacer.spacingMs).toBe(pacingConfig.minSpacingMs);
  });

  it("spaces concurrent acquires sequentially instead of releasing them together", async () => {
    const { pacer, waits } = harness();
    pacingConfig.minSpacingMs = 200;
    pacer.penalize();
    await Promise.all([pacer.acquire(), pacer.acquire(), pacer.acquire()]);
    // First reserves now; the other two queue behind it one spacing apart.
    expect(waits).toEqual([200, 200]);
  });

  it("relaxes one step after a quiet period and returns to dormant", async () => {
    const { pacer, advance } = harness();
    pacingConfig.minSpacingMs = 200;
    pacer.penalize();
    advance(pacingConfig.penaltyCoalesceMs);
    pacer.penalize();
    expect(pacer.spacingMs).toBe(400);

    advance(pacingConfig.decayAfterMs);
    await pacer.acquire();
    expect(pacer.spacingMs).toBe(200);

    advance(pacingConfig.decayAfterMs);
    await pacer.acquire();
    expect(pacer.spacingMs).toBe(0);
  });

  it("keeps spacing while rejections are still recent", async () => {
    const { pacer, advance } = harness();
    pacer.penalize();
    advance(pacingConfig.decayAfterMs - 1);
    await pacer.acquire();
    expect(pacer.spacingMs).toBe(pacingConfig.minSpacingMs);
  });

  it("does nothing when disabled", async () => {
    const { pacer, waits } = harness();
    pacingConfig.enabled = false;
    pacer.penalize();
    await pacer.acquire();
    await pacer.acquire();
    expect(waits).toEqual([]);
  });

  it("rejects an aborted caller and keeps serving the rest of the queue", async () => {
    const { pacer, waits } = harness();
    pacingConfig.minSpacingMs = 200;
    pacer.penalize();
    const ac = new AbortController();
    ac.abort(new Error("cancelled"));

    await expect(pacer.acquire(ac.signal)).rejects.toThrow("cancelled");
    await pacer.acquire();
    await pacer.acquire();
    expect(waits).toEqual([200]);
  });

  it("reset() clears accumulated state", async () => {
    const { pacer, waits, store } = harness();
    pacer.penalize();
    pacer.reset();
    // reset() is local; the published state outlives it by design, so drop it
    // too to assert the pacer really went dormant.
    store.state = undefined;
    expect(pacer.spacingMs).toBe(0);
    await pacer.acquire();
    await pacer.acquire();
    expect(waits).toEqual([]);
  });
});

describe("RequestPacer cross-process state", () => {
  beforeEach(() => {
    // The suite disables sharing globally (see test/setup.ts); these tests are
    // the ones that exercise it, against an injected in-memory store.
    pacingConfig.shared = true;
  });

  it("adopts spacing another process already paid for", async () => {
    const { pacer, store, waits } = harness();
    // A sibling process hit the limit moments ago.
    store.state = { spacingMs: 800, nextAllowedAt: 0, lastPenaltyAt: 1_000 };

    await pacer.acquire();
    expect(pacer.spacingMs).toBe(800);
    // This process starts spaced instead of rediscovering the limit itself.
    await pacer.acquire();
    expect(waits).toEqual([800]);
  });

  it("waits out a reservation made by another process", async () => {
    const { pacer, store, waits, now } = harness();
    store.state = { spacingMs: 200, nextAllowedAt: now() + 500, lastPenaltyAt: now() };

    await pacer.acquire();
    expect(waits).toEqual([500]);
  });

  it("publishes penalties so other processes can adopt them", () => {
    const { pacer, store, now } = harness();
    pacer.penalize();
    expect(store.writes).toBeGreaterThan(0);
    expect(store.state).toEqual({
      spacingMs: pacingConfig.minSpacingMs,
      nextAllowedAt: 0,
      lastPenaltyAt: now(),
    });
  });

  it("never lets shared state exceed the configured ceiling", async () => {
    const { pacer, store } = harness();
    store.state = { spacingMs: 10 * pacingConfig.maxSpacingMs, nextAllowedAt: 0, lastPenaltyAt: 1_000 };
    await pacer.acquire();
    expect(pacer.spacingMs).toBe(pacingConfig.maxSpacingMs);
  });

  it("polls at most once per sharedPollMs while dormant", async () => {
    const { pacer, store, advance } = harness();
    await pacer.acquire();
    await pacer.acquire();
    await pacer.acquire();
    expect(store.reads).toBe(1);

    advance(pacingConfig.sharedPollMs);
    await pacer.acquire();
    expect(store.reads).toBe(2);
  });

  it("reads on every reservation once spacing is active", async () => {
    const { pacer, store } = harness();
    pacer.penalize();
    const before = store.reads;
    await pacer.acquire();
    await pacer.acquire();
    expect(store.reads).toBe(before + 2);
  });

  it("stays process-local when sharing is disabled", async () => {
    const { pacer, store } = harness();
    pacingConfig.shared = false;
    store.state = { spacingMs: 4_000, nextAllowedAt: 9_999_999, lastPenaltyAt: 1_000 };

    pacer.penalize();
    await pacer.acquire();

    expect(store.reads).toBe(0);
    expect(store.writes).toBe(0);
    expect(pacer.spacingMs).toBe(pacingConfig.minSpacingMs);
  });
});

describe("FilePacingStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiro-pacing-"));

  it("round-trips state through the file", () => {
    const store = new FilePacingStore(join(dir, "state.json"));
    store.write({ spacingMs: 400, nextAllowedAt: 123, lastPenaltyAt: 456 });
    expect(store.read()).toEqual({ spacingMs: 400, nextAllowedAt: 123, lastPenaltyAt: 456 });
  });

  it("returns undefined for a missing file", () => {
    expect(new FilePacingStore(join(dir, "absent.json")).read()).toBeUndefined();
  });

  it("returns undefined for corrupt or incomplete content", () => {
    const truncated = join(dir, "truncated.json");
    writeFileSync(truncated, '{"spacingMs":400,"nextAll');
    expect(new FilePacingStore(truncated).read()).toBeUndefined();

    const wrongShape = join(dir, "wrong.json");
    writeFileSync(wrongShape, '{"spacingMs":"400","nextAllowedAt":1,"lastPenaltyAt":2}');
    expect(new FilePacingStore(wrongShape).read()).toBeUndefined();

    const notObject = join(dir, "scalar.json");
    writeFileSync(notObject, "42");
    expect(new FilePacingStore(notObject).read()).toBeUndefined();
  });

  it("does not throw when the path is unwritable", () => {
    const store = new FilePacingStore(join(dir, "no-such-dir", "\0invalid", "state.json"));
    expect(() => store.write({ spacingMs: 1, nextAllowedAt: 2, lastPenaltyAt: 3 })).not.toThrow();
    expect(store.read()).toBeUndefined();
  });
});
