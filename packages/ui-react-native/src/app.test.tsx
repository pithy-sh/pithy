// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { act, cleanup, render, screen } from "@testing-library/react";
import { Text } from "react-native";
import { afterEach, expect, test, vi } from "vitest";
import { expoRouter } from "../testing/expo-router";

vi.mock("../templates/src/route-modules", () => ({
  pithyRoutes: [async () => ({ path: "/otp", default: () => <Text>otp screen</Text> })],
  appRoutes: [async () => ({ path: "/", default: () => <Text>home screen</Text> })],
  sessionModule: undefined,
  paymentsModule: undefined,
  storeTransactions: undefined,
}));

afterEach(cleanup);

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
