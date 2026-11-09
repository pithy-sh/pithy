// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createMemoryAdapter, RouterProvider } from "../templates/src/router";

const session = vi.hoisted(() => ({
  signOut: { run: vi.fn(async () => undefined), pending: false, failure: null as Error | null },
}));

vi.mock("../templates/src/session", () => ({
  useSession: () => ({
    session: { user: { id: "u1", email: "ada@example.com" } },
    loading: false,
    refresh: () => undefined,
  }),
  useSignOut: () => session.signOut,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.signOut = { run: vi.fn(async () => undefined), pending: false, failure: null };
});

describe("the signed-in home screen", () => {
  test("names who is signed in, asks for a session, and signs out", async () => {
    const home = await import("../templates/src/routes/app/home");
    expect(home.path).toBe("/");
    expect(home.session).toBe("required");
    render(
      <RouterProvider adapter={createMemoryAdapter("/")}>
        <home.default />
      </RouterProvider>,
    );
    expect(screen.getByText("Signed in as ada@example.com.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(session.signOut.run).toHaveBeenCalled();
  });

  test("a sign-out that did not finish says the person is still signed in, and offers it again", async () => {
    session.signOut = {
      run: vi.fn(async () => undefined),
      pending: false,
      failure: new Error("The session did not end."),
    };
    const home = await import("../templates/src/routes/app/home");
    render(
      <RouterProvider adapter={createMemoryAdapter("/")}>
        <home.default />
      </RouterProvider>,
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "We couldn't sign you out, so you're still signed in. Try again.",
    );
    expect(screen.getByText("Signed in as ada@example.com.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button"));
    expect(session.signOut.run).toHaveBeenCalled();
  });

  test("a sign-out in flight cannot be started twice", async () => {
    session.signOut = { run: vi.fn(async () => undefined), pending: true, failure: null };
    const home = await import("../templates/src/routes/app/home");
    render(
      <RouterProvider adapter={createMemoryAdapter("/")}>
        <home.default />
      </RouterProvider>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(session.signOut.run).not.toHaveBeenCalled();
  });
});

describe("the bare home screen", () => {
  test("says what the Worker's health route answered", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ status: "ok" })));
    const home = await import("../templates/src/routes/app/home.bare");
    await act(async () => {
      render(<home.default />);
    });
    await waitFor(() => expect(screen.getByText("The worker says: ok.")).toBeTruthy());
  });

  test("says unreachable when nothing answers", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("offline");
    });
    const home = await import("../templates/src/routes/app/home.bare");
    await act(async () => {
      render(<home.default />);
    });
    await waitFor(() => expect(screen.getByText("The worker says: unreachable.")).toBeTruthy());
  });
});
