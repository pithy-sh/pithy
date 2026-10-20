// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ACCOUNT_DELETED, ACCOUNT_SUSPENDED } from "@pithy-sh/auth/src/client/lifecycle";
import { KIT_CATALOGS } from "@pithy-sh/i18n/src/catalogs/kit";
import { TranslatorProvider } from "@pithy-sh/i18n/src/react/translator";
import { act, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * The three lifecycle screens (#620), rendered: account suspended, account deleted, organization
 * suspended. Copied into an adopter's repository by the auth group, so each has to stand up there on its
 * own — its own English, the shared stylesheet's classes and nothing else, in both color schemes, and no
 * address of Pithy's anywhere in it. `lifecycleScreens.test.ts` beside this holds the source-text half,
 * which needs a file system a rendering program does not have.
 */

/**
 * The classes these screens draw with. `lifecycleScreens.test.ts` holds every one of them to being defined
 * in `pithy-screens.css`, which declares each color token for light and again for dark.
 */
const LIFECYCLE_SCREEN_CLASSES: ReadonlySet<string> = new Set(["screen", "muted", "stack", "secondary"]);

const signOut = vi.fn(async () => {});
vi.mock("../templates/src/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../templates/src/session")>()),
  signOut: () => signOut(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SCREENS = {
  "src/routes/pithy/account-suspended.tsx": () => import("../templates/src/routes/pithy/account-suspended"),
  "src/routes/pithy/account-deleted.tsx": () => import("../templates/src/routes/pithy/account-deleted"),
  "src/routes/pithy/organization-suspended.tsx": () => import("../templates/src/routes/pithy/organization-suspended"),
} as const;

let mounted: { container: HTMLElement; unmount: () => void } | null = null;

async function render(node: ReactNode): Promise<HTMLElement> {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  mounted = {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
  return container;
}

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  signOut.mockClear();
});

describe("the lifecycle screens", () => {
  test("each claims its role, so a refusal reaches it by job rather than by a path somebody copied", async () => {
    const roles = await Promise.all(Object.values(SCREENS).map(async (load) => (await load()).role));
    expect(roles).toEqual(["account-suspended", "account-deleted", "organization-suspended"]);
  });
});

describe.each(Object.entries(SCREENS))("%s", (_path, load) => {
  test("renders its own English with nothing composed", async () => {
    const { default: Screen } = (await load()) as { default: ComponentType };
    const container = await render(<Screen />);
    expect(container.querySelector("h1")?.textContent?.length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/\b(auth|organization)\/[a-z_.]+/);
  });

  test("renders the kit's Spanish through a mounted translator, not the English", async () => {
    const { default: Screen } = (await load()) as { default: ComponentType };
    const english = (await render(<Screen />)).textContent ?? "";
    mounted?.unmount();
    const container = await render(
      <TranslatorProvider value={{ catalogLocale: "es", formattingLocale: "es", layers: [KIT_CATALOGS.es] }}>
        <Screen />
      </TranslatorProvider>,
    );
    expect(container.textContent).not.toBe(english);
    expect(container.textContent).not.toMatch(/\b(auth|organization)\/[a-z_.]+/);
  });

  test("renders in both themes: only the shared stylesheet's classes, and no color of its own", async () => {
    // The two schemes are the stylesheet's: every token it reads is declared for light and redeclared
    // under `prefers-color-scheme: dark` (palette.test.ts holds that half). A screen keeps both only by
    // drawing with those classes and nothing else — an inline style or a class nothing defines is the
    // one way to be legible in one scheme and not the other.
    const { default: Screen } = (await load()) as { default: ComponentType };
    const container = await render(<Screen />);
    for (const element of container.querySelectorAll("*")) {
      expect(element.getAttribute("style"), element.outerHTML).toBeNull();
      for (const name of element.classList) {
        expect(LIFECYCLE_SCREEN_CLASSES.has(name), `.${name} is not one the stylesheet is held to`).toBe(true);
      }
    }
  });

  test("names no Pithy-hosted origin in what it renders — no address at all, in fact", async () => {
    const { default: Screen } = (await load()) as { default: ComponentType };
    const container = await render(<Screen />);
    expect(container.innerHTML).not.toMatch(/https?:\/\//);
    expect(container.innerHTML).not.toMatch(/pithy\.(sh|dev)/);
  });
});

describe("the account screens", () => {
  test.each([
    ["account-suspended", () => import("../templates/src/routes/pithy/account-suspended")],
    ["account-deleted", () => import("../templates/src/routes/pithy/account-deleted")],
  ] as const)("%s offers a way to sign out, which ends the session left on this device", async (_role, load) => {
    const { default: Screen } = await load();
    const container = await render(<Screen />);
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
    });
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});

describe("refusedAccountScreen — the one place a refusal is turned into a destination", () => {
  test("names the screen for each lifecycle code, and nothing for any other", async () => {
    const { refusedAccountScreen } = await import("../templates/src/session");
    expect(refusedAccountScreen(ACCOUNT_SUSPENDED)).toBe("account-suspended");
    expect(refusedAccountScreen(ACCOUNT_DELETED)).toBe("account-deleted");
    expect(refusedAccountScreen("provider_sign_in_refused")).toBeNull();
    expect(refusedAccountScreen(null)).toBeNull();
  });
});
