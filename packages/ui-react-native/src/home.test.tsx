// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createMemoryAdapter, RouterProvider } from "../templates/src/router";

const session = vi.hoisted(() => ({ signOut: vi.fn(async () => undefined) }));

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
    fireEvent.click(screen.getByRole("button"));
    expect(session.signOut).toHaveBeenCalled();
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
