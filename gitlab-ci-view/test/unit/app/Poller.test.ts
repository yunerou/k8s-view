import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type PollClient, Poller } from "../../../src/app/Poller";
import { FakeSettings } from "../helpers/fakes";

class Client implements PollClient {
  calls = 0;
  constructor(
    public active = false,
    public shown = true,
  ) {}
  visible() {
    return this.shown;
  }
  async refresh() {
    this.calls++;
    return this.active;
  }
}

let settings: FakeSettings;
let poller: Poller;

beforeEach(() => {
  vi.useFakeTimers();
  settings = new FakeSettings();
  poller = new Poller(settings);
});

afterEach(() => {
  poller.dispose();
  vi.useRealTimers();
});

describe("Poller", () => {
  test("polls every activeSeconds while something runs, idleSeconds otherwise", async () => {
    const client = new Client(true);
    poller.register(client);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.calls).toBe(2);
    client.active = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.calls).toBe(3);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(client.calls).toBe(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.calls).toBe(4);
  });

  test("skips hidden clients and survives a failing one", async () => {
    const hidden = new Client(false, false);
    const failing: PollClient = { visible: () => true, refresh: () => Promise.reject(new Error("boom")) };
    const ok = new Client();
    poller.register(hidden);
    poller.register(failing);
    poller.register(ok);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect([hidden.calls, ok.calls]).toEqual([0, 1]);
  });

  test("pauses while the window is unfocused and refreshes on focus", async () => {
    const client = new Client();
    poller.register(client);
    poller.setFocused(false);
    poller.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(client.calls).toBe(0);
    poller.setFocused(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.calls).toBe(1);
  });

  test("now() during a refresh queues exactly one more refresh", async () => {
    let release: () => void = () => undefined;
    let calls = 0;
    poller.register({
      visible: () => true,
      refresh: () => {
        calls++;
        return new Promise<boolean>((r) => {
          release = () => r(false);
        });
      },
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.now();
    poller.now();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
  });

  test("dispose stops polling and unregister works", async () => {
    const client = new Client();
    const reg = poller.register(client);
    reg.dispose();
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.calls).toBe(0);
    poller.register(client);
    poller.dispose();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(client.calls).toBe(0);
  });
});
