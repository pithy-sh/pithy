// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { RouteModule, ScreenProps } from "@pithy-sh/ui-core/src/routes";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { Pressable, Text } from "react-native";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CATCH_ALL_PARAM,
  createMemoryAdapter,
  Link,
  Redirect,
  Router,
  RouterProvider,
  useExpoRouterAdapter,
  useGo,
  useSearchParam,
  useUpdateSearch,
} from "../templates/src/router";
import { expoRouter } from "../testing/expo-router";

const state = vi.hoisted(() => ({
  signedIn: true as boolean | null,
  holds: new Set<string>(),
}));

function route(
  module: Omit<RouteModule, "default"> & { default: (props: ScreenProps) => ReactNode },
): () => Promise<RouteModule> {
  return async () => module as RouteModule;
}

function Counter(): ReactNode {
  const [count, setCount] = useState(0);
  const [leaving, setLeaving] = useState(false);
  if (leaving) return <Redirect to="/counter?again=1" load />;
  return (
    <>
      <Text>{`count ${count}`}</Text>
      <Pressable onPress={() => setCount(count + 1)}>
        <Text>more</Text>
      </Pressable>
      <Pressable onPress={() => setLeaving(true)}>
        <Text>switch</Text>
      </Pressable>
    </>
  );
}

function Search(): ReactNode {
  const email = useSearchParam("email");
  const update = useUpdateSearch();
  const go = useGo();
  return (
    <>
      <Text>{`email ${email ?? "none"}`}</Text>
      <Pressable onPress={() => update({ email: null, step: "2" })}>
        <Text>update</Text>
      </Pressable>
      <Pressable onPress={() => go("/search?email=ada%40example.com")}>
        <Text>same</Text>
      </Pressable>
      <Link to="/">home</Link>
    </>
  );
}

vi.mock("../templates/src/route-modules", () => ({
  pithyRoutes: [
    route({ path: "/sign-in", role: "sign-in", default: () => <Text>sign in</Text> }),
    route({ path: "/paywall", role: "paywall", default: () => <Text>paywall</Text> }),
    route({ path: "/invitations/:token", default: ({ params }) => <Text>{`token ${params.token}`}</Text> }),
    route({ path: "/invitations/new", default: () => <Text>new invitation</Text> }),
  ],
  appRoutes: [
    route({ path: "/", session: "required", default: () => <Text>home</Text> }),
    route({ path: "/pro", entitlement: "pro", default: () => <Text>pro</Text> }),
    route({ path: "/counter", default: () => <Counter /> }),
    route({ path: "/search", default: () => <Search /> }),
    route({ path: "/to-sign-in", default: () => <Redirect screen="sign-in" search="resume=%2Fpro" replace /> }),
  ],
  sessionModule: async () => ({ getSession: async () => (state.signedIn ? { user: { id: "u1" } } : null) }),
  paymentsModule: async () => ({ holdsEntitlement: async (key: string) => state.holds.has(key) }),
}));

afterEach(() => {
  cleanup();
  state.signedIn = true;
  state.holds = new Set();
});

/** Mount the router at `path`, letting the route table resolve inside `act` the way a real render waits for it. */
async function mount(path: string) {
  const adapter = createMemoryAdapter(path);
  await act(async () => {
    render(<Router adapter={adapter} />);
  });
  return adapter;
}

describe("the screen for the path", () => {
  test("renders the screen whose pattern matches, with its parameters decoded", async () => {
    await mount("/invitations/a%2Fb");
    expect(await screen.findByText("token a/b")).toBeTruthy();
  });

  test("a static pattern beats a parameter at the same place", async () => {
    await mount("/invitations/new");
    expect(await screen.findByText("new invitation")).toBeTruthy();
  });

  test("a path nothing answers says so, and links home", async () => {
    const adapter = await mount("/nowhere");
    expect(await screen.findByText("Nothing answers /nowhere.")).toBeTruthy();
    fireEvent.click(screen.getByRole("link"));
    expect(adapter.path()).toBe("/");
  });
});

describe("the guards", () => {
  test("a signed-out visitor to a session screen is sent to the path the sign-in screen declares", async () => {
    state.signedIn = false;
    const adapter = await mount("/");
    await waitFor(() => expect(adapter.path()).toBe("/sign-in"));
    expect(await screen.findByText("sign in")).toBeTruthy();
  });

  test("a signed-in visitor sees it", async () => {
    await mount("/");
    expect(await screen.findByText("home")).toBeTruthy();
  });

  test("a visitor without the entitlement is sent to the paywall; one holding it sees the screen", async () => {
    const adapter = await mount("/pro");
    await waitFor(() => expect(adapter.path()).toBe("/paywall"));
    cleanup();
    state.holds.add("pro");
    await mount("/pro");
    expect(await screen.findByText("pro")).toBeTruthy();
  });
});

describe("going elsewhere", () => {
  test("a redirect by role goes to the path that screen declares, with its query, replacing the entry", async () => {
    const adapter = await mount("/to-sign-in");
    await waitFor(() => expect(adapter.path()).toBe("/sign-in?resume=%2Fpro"));
    expect(adapter.history).toEqual(["/sign-in?resume=%2Fpro"]);
  });

  test("a redirect that loads remounts every screen, so nothing they held survives", async () => {
    const adapter = await mount("/counter");
    fireEvent.click(await screen.findByText("more"));
    expect(screen.getByText("count 1")).toBeTruthy();
    fireEvent.click(screen.getByText("switch"));
    await waitFor(() => expect(adapter.path()).toBe("/counter?again=1"));
    expect(await screen.findByText("count 0")).toBeTruthy();
  });

  test("a query parameter is read decoded, and updating the query keeps the path", async () => {
    const adapter = await mount("/search?email=ada%40example.com");
    expect(await screen.findByText("email ada@example.com")).toBeTruthy();
    fireEvent.click(screen.getByText("update"));
    expect(adapter.path()).toBe("/search?step=2");
    expect(await screen.findByText("email none")).toBeTruthy();
  });

  test("going where the app already is pushes nothing", async () => {
    const adapter = await mount("/search?email=ada%40example.com");
    fireEvent.click(await screen.findByText("same"));
    expect(adapter.history).toHaveLength(1);
  });

  test("a screen outside the router is told where to mount it", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Link to="/">home</Link>)).toThrow(/outside <Router>/);
  });
});

describe("the expo-router binding", () => {
  function Where(): ReactNode {
    const adapter = useExpoRouterAdapter();
    return (
      <RouterProvider adapter={adapter}>
        <Search />
      </RouterProvider>
    );
  }

  test("reads the path and the query, leaving out the segment the catch-all route captured", async () => {
    expoRouter.visit(`/search?email=ada%40example.com&${CATCH_ALL_PARAM}=search`);
    render(<Where />);
    expect(screen.getByText("email ada@example.com")).toBeTruthy();
    fireEvent.click(screen.getByText("update"));
    expect(expoRouter.history.at(-1)).toEqual({ kind: "push", href: "/search?step=2" });
    expect(await screen.findByText("email none")).toBeTruthy();
  });

  test("a deep link the app is opened on re-renders the screen", async () => {
    render(<Where />);
    act(() => expoRouter.visit("/search?email=grace%40example.com"));
    expect(await screen.findByText("email grace@example.com")).toBeTruthy();
  });
});
