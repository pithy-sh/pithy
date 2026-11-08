import { HEALTH_PATH } from "@pithy-sh/core/src/worker/health";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { Platform } from "react-native";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Your home screen, rendered on the web and on a phone. `vitest.config.ts` renders React Native through
// `react-native-web` and swaps every native module for a stand-in from `@pithy-sh/ui-react-native/testing`, which
// a test imports by that path to drive it. The Worker is a stubbed `fetch`, so nothing leaves the machine.

let asked: string[] = [];
let answer: () => Promise<Response>;

beforeEach(() => {
  asked = [];
  answer = async () => new Response(JSON.stringify({ status: "ok" }));
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(url);
    return answer();
  });
});

const os = Platform.OS;
afterEach(() => {
  cleanup();
  Platform.OS = os;
  vi.unstubAllGlobals();
  // Each test reads `Platform.OS` afresh, so the screen and everything it imports load again.
  vi.resetModules();
});

/** Render the home screen on `platform`. */
async function openOn(platform: "web" | "ios"): Promise<void> {
  Platform.OS = platform;
  const home = await import("./home");
  await act(async () => {
    render(<home.default />);
  });
}

test("on the web, asks the Worker's health route on this origin and says what it answered", async () => {
  await openOn("web");
  await waitFor(() => expect(screen.getByText("The worker says: ok.")).toBeTruthy());
  expect(asked).toEqual([HEALTH_PATH]);
});

test("on a phone, asks the Worker's own origin", async () => {
  const { origin } = await import("../../pithy-config");
  await openOn("ios");
  await waitFor(() => expect(screen.getByText("The worker says: ok.")).toBeTruthy());
  expect(asked).toEqual([`${origin}${HEALTH_PATH}`]);
});

test("says unreachable when nothing answers", async () => {
  answer = async () => {
    throw new TypeError("offline");
  };
  await openOn("ios");
  await waitFor(() => expect(screen.getByText("The worker says: unreachable.")).toBeTruthy());
});
