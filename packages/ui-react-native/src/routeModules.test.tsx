// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, expect, test, vi } from "vitest";

/**
 * The registration, against a stand-in for Metro's `require.context`: the directory listings below are what Metro
 * would see, and the filter is the one the template hands it, applied the way Metro applies it.
 */
const FILES: Record<string, string[]> = {
  "./routes": [
    "./pithy/sign-in.tsx",
    "./pithy/sign-in.test.tsx",
    "./pithy/otp.spec.tsx",
    "./pithy/nested/deep.tsx",
    "./pithy/notes.md",
    "./app/home.tsx",
    "./app/home.test.tsx",
    "./application.tsx",
  ],
  "./": ["./session.tsx", "./session.test.tsx", "./router.tsx", "./payments.tsx"],
};

const asked: { path: string; recursive: boolean; mode: string }[] = [];

/** A directory Metro cannot find fails the bundle, so the stand-in throws for one too. */
function context(path: string, recursive: boolean, filter: RegExp, mode: string) {
  asked.push({ path, recursive, mode });
  if (!(path in FILES)) throw new Error(`Metro: no directory ${path}`);
  const keys = (FILES[path] ?? []).filter((key) => filter.test(key));
  return Object.assign((id: string) => ({ path: `${path}:${id}` }), { keys: () => keys });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  asked.length = 0;
});

test("every screen is registered and no test is, in a stable order", async () => {
  vi.stubGlobal("require", { context });
  const modules = await import("../templates/src/route-modules");
  const pithy = await Promise.all(modules.pithyRoutes.map((load) => load()));
  expect(pithy).toEqual([{ path: "./routes:./pithy/nested/deep.tsx" }, { path: "./routes:./pithy/sign-in.tsx" }]);
  expect(await Promise.all(modules.appRoutes.map((load) => load()))).toEqual([{ path: "./routes:./app/home.tsx" }]);
  expect(asked.every((call) => call.mode === "sync")).toBe(true);
});

test("the session and payments modules are found when they were written, and only those files", async () => {
  vi.stubGlobal("require", { context });
  const modules = await import("../templates/src/route-modules");
  expect(await modules.sessionModule?.()).toEqual({ path: "./:./session.tsx" });
  expect(await modules.paymentsModule?.()).toEqual({ path: "./:./payments.tsx" });
});

test("a bare app, with no screens of Pithy's on disk, bundles with only its own", async () => {
  const full = FILES["./routes"];
  FILES["./routes"] = ["./app/home.tsx"];
  try {
    vi.stubGlobal("require", { context });
    const modules = await import("../templates/src/route-modules");
    expect(modules.pithyRoutes).toEqual([]);
    expect(await Promise.all(modules.appRoutes.map((load) => load()))).toEqual([{ path: "./routes:./app/home.tsx" }]);
    expect(asked.map((call) => call.path).filter((path) => path.startsWith("./routes/"))).toEqual([]);
  } finally {
    FILES["./routes"] = full ?? [];
  }
});

test("an app without them has neither, and its guards let everyone through", async () => {
  FILES["./"] = ["./router.tsx"];
  vi.stubGlobal("require", { context });
  const modules = await import("../templates/src/route-modules");
  expect(modules.sessionModule).toBeUndefined();
  expect(modules.paymentsModule).toBeUndefined();
});
