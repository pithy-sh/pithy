// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { act, cleanup, render, screen } from "@testing-library/react";
import { Platform, Text } from "react-native";
import { afterEach, describe, expect, test, vi } from "vitest";
import { expoRouter } from "../testing/expo-router";

/** The store listener the layout mounts, when a test writes one: here, a hook that counts its renders. */
const store = vi.hoisted(() => ({ listen: undefined as (() => void) | undefined }));

vi.mock("../templates/src/route-modules", () => ({
  pithyRoutes: [async () => ({ path: "/otp", default: () => <Text>otp screen</Text> })],
  appRoutes: [async () => ({ path: "/", default: () => <Text>home screen</Text> })],
  sessionModule: undefined,
  paymentsModule: undefined,
  get storeTransactions() {
    return store.listen;
  },
}));

const os = Platform.OS;

afterEach(() => {
  cleanup();
  store.listen = undefined;
  Platform.OS = os;
});

test("the root layout mounts, with the locale over whatever route expo-router resolved", async () => {
  const { default: Layout } = await import("../templates/app/_layout");
  await act(async () => {
    render(<Layout />);
  });
  expect(document.body.textContent).toBe("");
});

test("every path expo-router lands on is handed to the kit's router", async () => {
  const { default: CatchAll } = await import("../templates/app/[...pithy]");
  const { default: Index } = await import("../templates/app/index");
  expoRouter.visit("/otp?email=ada%40example.com&pithy=otp");
  await act(async () => {
    render(<CatchAll />);
  });
  expect(screen.getByText("otp screen")).toBeTruthy();
  cleanup();
  expoRouter.visit("/");
  await act(async () => {
    render(<Index />);
  });
  expect(screen.getByText("home screen")).toBeTruthy();
});

/**
 * How many times a component under the root layout renders on mount. `StrictMode` renders every component twice in
 * a dev build, which is what the tests run, so two means the tree is under it and one means it is not.
 */
async function rendersOn(platform: typeof Platform.OS): Promise<number> {
  Platform.OS = platform;
  let renders = 0;
  store.listen = () => {
    renders += 1;
  };
  const { default: Layout } = await import("../templates/app/_layout");
  await act(async () => {
    render(<Layout />);
  });
  return renders;
}

describe("StrictMode in the root layout", () => {
  test.each(["ios", "android", "web"] as const)("the %s build renders under it", async (platform) => {
    expect(await rendersOn(platform)).toBe(2);
  });
});
