// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { reactStub } from "./react";
import { definedClassNames, PITHY_SCREEN_DIR, renderedClassNames, unstyledScreenClasses } from "./screenStyles";
import { loadStubFiles } from "./templates";

/** Every file `pithy ui add react --auth --payments` writes, contents and all. */
async function everyScreen(): Promise<Record<string, string>> {
  return loadStubFiles(reactStub, { worker: "board", auth: true, payments: true, packageManager: "bun" });
}

describe("renderedClassNames", () => {
  test("reads a literal className", () => {
    expect(renderedClassNames('<div className="screen"><p className="muted stack">x</p></div>')).toEqual([
      "muted",
      "screen",
      "stack",
    ]);
  });

  test("reads the literals out of an expression, because a conditional class still renders", () => {
    expect(renderedClassNames('<button className={busy ? "secondary" : "primary"}>go</button>')).toEqual([
      "primary",
      "secondary",
    ]);
  });

  test("a class assembled at runtime contributes nothing, which is the honest answer", () => {
    expect(renderedClassNames("<div className={variant} />")).toEqual([]);
  });
});

describe("definedClassNames", () => {
  test("reads selectors and not declarations, comments, or content strings", () => {
    const css = `
      /* .commented-out */
      .screen { background: var(--bg); }
      .divider::before { content: ".not-a-class"; }
    `;
    expect(definedClassNames(css)).toEqual(["divider", "screen"]);
  });

  test("sees inside a cascade layer — the layer is how these rules stay overridable", () => {
    expect(definedClassNames("@layer pithy { .stack { gap: 0.75rem; } }")).toEqual(["stack"]);
  });

  test("reads a compound selector's class", () => {
    expect(definedClassNames(".screen button.secondary { color: red; }")).toEqual(["screen", "secondary"]);
  });
});

/**
 * The gate, stated over the template rather than over one file: **every class name a Pithy screen
 * renders is defined by a stylesheet that same command writes.**
 *
 * It catches the drift in the direction this arrived from — a screen gaining a class whose rule lives in
 * a file the backfill path never writes — and it catches the reverse.
 */
describe("every class a Pithy screen renders is defined by a stylesheet the same run writes", () => {
  test("the react stub, with every screen set", async () => {
    expect(unstyledScreenClasses(await everyScreen())).toEqual([]);
  });

  test("the screens carry their own stylesheet, so a backfill writes it with them", async () => {
    // Present is not enough: a stylesheet nothing imports styles nothing. The screens import it
    // themselves rather than relying on `client.tsx`, which a backfill correctly leaves alone.
    const files = await everyScreen();
    expect(files["src/pithy-screens.css"]).toBeDefined();
    for (const [path, contents] of Object.entries(files)) {
      // A co-located gate beside a screen renders no screen of its own, so it imports no stylesheet.
      if (!path.startsWith(PITHY_SCREEN_DIR) || path.includes(".test.")) continue;
      expect(contents, path).toContain("pithy-screens.css");
    }
  });

  test("and it bites: a screen renders one class nothing defines", async () => {
    const files = await everyScreen();
    const signIn = files["src/routes/pithy/sign-in.tsx"];
    expect(signIn).toBeDefined();
    const planted = { ...files, "src/routes/pithy/sign-in.tsx": `${signIn}\n// <div className="lonely" />\n` };
    expect(unstyledScreenClasses(planted)).toEqual(["lonely"]);
  });

  test("and it bites the other way: the stylesheet the screens depend on goes missing", async () => {
    const { "src/pithy-screens.css": _dropped, ...withoutStylesheet } = await everyScreen();
    // Exactly the reported failure — the classes the adopter saw unstyled, named. The sign-in page's
    // own layout is most of this list, which is the point: it is the screen with the most to lose.
    expect(unstyledScreenClasses(withoutStylesheet)).toEqual([
      "auth",
      "auth__brand",
      "auth__check",
      "auth__credentials",
      "auth__failed",
      "auth__form",
      "auth__form-mark",
      "auth__mark",
      "auth__provider",
      "auth__providers",
      "auth__signup",
      "divider",
      "muted",
      "otp",
      "screen",
      "secondary",
      "stack",
    ]);
  });
});
