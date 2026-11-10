// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test, vi } from "vitest";
import { createGate } from "./testing";

afterEach(() => {
  vi.useRealTimers();
});

describe("createGate", () => {
  test("starts closed and reports open once opened", () => {
    const gate = createGate();
    expect(gate.isOpen).toBe(false);
    gate.open();
    expect(gate.isOpen).toBe(true);
  });

  test("opened() resolves at once on a gate that is already open", async () => {
    const gate = createGate();
    gate.open();
    await expect(gate.opened()).resolves.toBeUndefined();
  });

  test("opened() waits until the gate is opened, checking on its own timer", async () => {
    vi.useFakeTimers();
    const gate = createGate({ pollMs: 10 });
    let through = false;
    const waiting = gate.opened().then(() => {
      through = true;
    });

    await vi.advanceTimersByTimeAsync(50);
    expect(through).toBe(false);

    gate.open();
    await vi.advanceTimersByTimeAsync(10);
    await waiting;
    expect(through).toBe(true);
  });

  test("opened() rejects when the gate stays closed past the timeout, naming the gate", async () => {
    vi.useFakeTimers();
    const gate = createGate({ name: "first run held", pollMs: 10, timeoutMs: 100 });
    const waiting = gate.opened();
    const settled = expect(waiting).rejects.toThrow(/first run held.*100ms/);
    await vi.advanceTimersByTimeAsync(110);
    await settled;
  });

  test("opening twice is harmless", () => {
    const gate = createGate();
    gate.open();
    gate.open();
    expect(gate.isOpen).toBe(true);
  });

  test.each([0, -1, Number.NaN])("refuses a pollMs of %s", (pollMs) => {
    expect(() => createGate({ pollMs })).toThrow(/pollMs/);
  });

  test.each([0, -5, Number.NaN])("refuses a timeoutMs of %s", (timeoutMs) => {
    expect(() => createGate({ timeoutMs })).toThrow(/timeoutMs/);
  });
});

describe("@pithy-sh/core/testing", () => {
  test("resolves through core's exports to the built gate", async () => {
    // A variable specifier, so the typecheck does not need `dist/` to exist; the runtime resolves it as an adopter would.
    const specifier = "@pithy-sh/core/testing";
    const published = (await import(/* @vite-ignore */ specifier)) as { createGate?: unknown };
    expect(typeof published.createGate).toBe("function");
    const gate = (published.createGate as typeof createGate)();
    gate.open();
    await expect(gate.opened()).resolves.toBeUndefined();
  });
});
