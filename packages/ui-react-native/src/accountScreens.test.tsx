// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { KIT_CATALOGS } from "@pithy-sh/i18n/src/catalogs/kit";
import { TranslatorProvider } from "@pithy-sh/i18n/src/react/translator";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createMemoryAdapter, RouterProvider } from "../templates/src/router";

const signOut = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../templates/src/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../templates/src/session")>()),
  useSignOut: () => signOut,
}));

afterEach(() => {
  cleanup();
  signOut.mockClear();
});

const SCREENS = {
  "account-suspended": () => import("../templates/src/routes/pithy/account-suspended"),
  "account-deleted": () => import("../templates/src/routes/pithy/account-deleted"),
} as const;

function mount(node: ReactNode) {
  return render(<RouterProvider adapter={createMemoryAdapter("/")}>{node}</RouterProvider>);
}

describe.each(Object.entries(SCREENS))("the %s screen", (role, load) => {
  test("claims its role at the path ui-react's does, so a refusal reaches it by job", async () => {
    const module = await load();
    expect(module.role).toBe(role);
    expect(module.path).toBe(`/${role}`);
  });

  test("renders its own English with nothing composed, under a heading", async () => {
    const { default: Screen } = (await load()) as { default: ComponentType };
    const { container } = mount(<Screen />);
    expect(screen.getByRole("heading").textContent).toMatch(/^Your account is (suspended|deleted)\.$/);
    expect(container.textContent).not.toMatch(/\bauth\/[a-z_.]+/);
  });

  test("renders the kit's Spanish through a mounted translator", async () => {
    const { default: Screen } = (await load()) as { default: ComponentType };
    const english = mount(<Screen />).container.textContent ?? "";
    cleanup();
    const { container } = mount(
      <TranslatorProvider value={{ catalogLocale: "es", formattingLocale: "es", layers: [KIT_CATALOGS.es] }}>
        <Screen />
      </TranslatorProvider>,
    );
    expect(container.textContent).not.toBe(english);
    expect(container.textContent).not.toMatch(/\bauth\/[a-z_.]+/);
  });

  test("names no address at all", async () => {
    const { default: Screen } = (await load()) as { default: ComponentType };
    expect(mount(<Screen />).container.innerHTML).not.toMatch(/https?:\/\//);
  });

  test("signs out once, which ends the session left on this device", async () => {
    const { default: Screen } = (await load()) as { default: ComponentType };
    mount(<Screen />);
    const button = screen.getByRole("button");
    await act(async () => {
      fireEvent.click(button);
    });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
