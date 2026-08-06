import { expect, describe, it, mock } from "bun:test";
import { Logger } from "../logging/logger.js";
import type { IntervalScheduler, Timer } from "../maintenance/compaction.js";
import { startAttentionTick } from "./tick.js";
import type { AttentionService } from "./service.js";

function fakeScheduler() {
  const calls: { callback: () => void; everyMillis: number }[] = [];
  let cleared = 0;
  const scheduler: IntervalScheduler = (callback, everyMillis): Timer => {
    calls.push({ callback, everyMillis });
    return { clear: () => (cleared += 1) };
  };
  return {
    scheduler,
    calls,
    tick: () => calls.at(-1)?.callback(),
    get cleared() {
      return cleared;
    },
  };
}

/** A stand-in with only the one method the tick is allowed to call. */
function fakeAttention() {
  const refresh = mock();
  return { refresh } as unknown as AttentionService;
}

describe("the attention tick (§7, principle 2)", () => {
  it("does not schedule anything when the interval is off, but runNow still re-derives", () => {
    const attention = fakeAttention();
    const timers = fakeScheduler();

    const tick = startAttentionTick({
      attention,
      logger: new Logger("error"),
      intervalSeconds: 0,
      scheduler: timers.scheduler,
    });

    expect(timers.calls).toHaveLength(0);
    tick.runNow();
    expect(attention.refresh).toHaveBeenCalledTimes(1);
  });

  it("re-derives on the configured interval", () => {
    const attention = fakeAttention();
    const timers = fakeScheduler();

    const tick = startAttentionTick({
      attention,
      logger: new Logger("error"),
      intervalSeconds: 30,
      scheduler: timers.scheduler,
    });

    expect(timers.calls[0]?.everyMillis).toBe(30_000);
    expect(tick.intervalSeconds).toBe(30);

    timers.tick();
    timers.tick();
    expect(attention.refresh).toHaveBeenCalledTimes(2);
  });

  it("keeps ticking after one re-derivation throws", () => {
    const attention = { refresh: mock() } as unknown as AttentionService;
    (attention.refresh as ReturnType<typeof mock>)
      .mockImplementationOnce(() => {
        throw new Error("derivation exploded");
      })
      .mockImplementation(() => undefined);
    const timers = fakeScheduler();

    startAttentionTick({
      attention,
      logger: new Logger("error"),
      intervalSeconds: 30,
      scheduler: timers.scheduler,
    });

    expect(() => timers.tick()).not.toThrow();
    expect(() => timers.tick()).not.toThrow();
    expect(attention.refresh).toHaveBeenCalledTimes(2);
  });

  it("stops once, however many times it is asked", () => {
    const attention = fakeAttention();
    const timers = fakeScheduler();
    const tick = startAttentionTick({
      attention,
      logger: new Logger("error"),
      intervalSeconds: 30,
      scheduler: timers.scheduler,
    });

    tick.stop();
    tick.stop();

    expect(timers.cleared).toBe(1);
  });

  it("reschedules without a restart (Epic 8.3)", () => {
    const attention = fakeAttention();
    const timers = fakeScheduler();
    const tick = startAttentionTick({
      attention,
      logger: new Logger("error"),
      intervalSeconds: 30,
      scheduler: timers.scheduler,
    });

    tick.reschedule(5);

    expect(timers.cleared).toBe(1);
    expect(timers.calls).toHaveLength(2);
    expect(timers.calls[1]?.everyMillis).toBe(5_000);
    expect(tick.intervalSeconds).toBe(5);

    timers.tick();
    expect(attention.refresh).toHaveBeenCalledTimes(1);
  });

  it("rescheduling to zero disables the schedule without disabling runNow", () => {
    const attention = fakeAttention();
    const timers = fakeScheduler();
    const tick = startAttentionTick({
      attention,
      logger: new Logger("error"),
      intervalSeconds: 30,
      scheduler: timers.scheduler,
    });

    tick.reschedule(0);

    expect(tick.intervalSeconds).toBe(0);
    expect(timers.calls).toHaveLength(1);

    tick.runNow();
    expect(attention.refresh).toHaveBeenCalledTimes(1);
  });

  it("a stopped tick ignores a reschedule rather than reviving itself", () => {
    const attention = fakeAttention();
    const timers = fakeScheduler();
    const tick = startAttentionTick({
      attention,
      logger: new Logger("error"),
      intervalSeconds: 30,
      scheduler: timers.scheduler,
    });

    tick.stop();
    tick.reschedule(10);

    expect(timers.calls).toHaveLength(1);
  });
});
