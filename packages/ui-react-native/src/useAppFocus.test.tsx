// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { act, cleanup, render } from "@testing-library/react";
import { AppState, type AppStateStatus } from "react-native";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useAppFocus } from "../templates/src/useAppFocus";

/**
 * **`useAppFocus` fires on a return to the foreground, whatever state the app reported first.**
 *
 * React Native types `AppState.currentState` as `AppStateStatus` on some releases and as `string | null | undefined`
 * on others, and at runtime it can be null before the native module answers. Only a move into `active` from
 * anything else fires, and a first state of null or one React Native does not name counts as "not active".
 */

/** Render the hook with `currentState` reading `first`, and answer with the listener and the call count. */
function mount(first: unknown): { change: (state: AppStateStatus) => void; calls: () => number } {
  vi.spyOn(AppState, "currentState", "get").mockReturnValue(first as AppStateStatus);
  let listener: (state: AppStateStatus) => void = () => undefined;
  vi.spyOn(AppState, "addEventListener").mockImplementation((_type, handler) => {
    listener = handler as (state: AppStateStatus) => void;
    return { remove: () => undefined };
  });
  let count = 0;
  function Probe(): null {
    useAppFocus(() => {
      count += 1;
    });
    return null;
  }
  render(<Probe />);
  return { change: (state) => act(() => listener(state)), calls: () => count };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useAppFocus", () => {
  test("does not fire on the first render", () => {
    expect(mount("background").calls()).toBe(0);
  });

  test("fires when the app comes back from the background", () => {
    const app = mount("active");
    app.change("background");
    app.change("active");
    expect(app.calls()).toBe(1);
  });

  test("does not fire for a change that stays active", () => {
    const app = mount("active");
    app.change("active");
    expect(app.calls()).toBe(0);
  });

  test.each([null, undefined, "unforeseen"])(
    "a first state of %s is not active, so the first active fires",
    (first) => {
      const app = mount(first);
      app.change("active");
      expect(app.calls()).toBe(1);
      app.change("active");
      expect(app.calls()).toBe(1);
    },
  );

  test("an unknown state the listener reports is not active either", () => {
    const app = mount("active");
    app.change("unforeseen" as AppStateStatus);
    app.change("active");
    expect(app.calls()).toBe(1);
  });
});
