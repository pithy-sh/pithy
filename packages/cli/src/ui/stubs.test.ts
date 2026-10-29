// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { resolveStub, UI_STUBS } from "./stubs";

describe("UI_STUBS", () => {
  test("registers react through the same declaration a later framework would use", () => {
    expect(Object.keys(UI_STUBS)).toEqual(["react", "react-native"]);
    const stub = resolveStub("react");
    // Everything pithy dev and pithy deploy need, declared by the stub rather than special-cased.
    expect(stub.devCommand("{port}")).toEqual([
      "vite",
      "dev",
      "--configLoader",
      "runner",
      "--strictPort",
      "--port",
      "{port}",
    ]);
    expect(stub.buildCommand).toEqual(["vite", "build", "--configLoader", "runner"]);
    expect(stub.readySignal).toBe("ready in \\d+");
    expect(new RegExp(stub.readySignal).test("  ready in 412 ms")).toBe(true);
  });

  test("--strictPort is not optional — Vite would otherwise drift off a pinned port", () => {
    expect(resolveStub("react").devCommand("5173")).toContain("--strictPort");
  });

  // Verified the hard way, by building a real scaffold: without it, Vite's default config loader
  // bundles vite.config.ts and leaves `@pithy-sh/vite` external, so Node has to import raw TypeScript
  // with extensionless relative imports — which it cannot resolve, and refuses to type-strip under
  // node_modules at all. Both commands need it; dropping either one breaks a real adopter's build.
  test("--configLoader runner is on both commands — the plugin is raw TS that Node cannot import", () => {
    const stub = resolveStub("react");
    for (const argv of [stub.devCommand("5173"), stub.buildCommand]) {
      expect(argv).toContain("--configLoader");
      expect(argv[argv.indexOf("--configLoader") + 1]).toBe("runner");
    }
  });

  test("react-native lives in an app of its own, and runs Expo on the pinned port", () => {
    const stub = resolveStub("react-native");
    expect(stub.placement).toBe("app");
    expect(resolveStub("react").placement ?? "worker").toBe("worker");
    expect(stub.devCommand("{port}")).toEqual(["expo", "start", "--port", "{port}"]);
    expect(stub.buildCommand).toEqual(["expo", "export", "--platform", "web"]);
    const ready = new RegExp(stub.readySignal);
    expect(ready.test("Waiting on http://localhost:8081")).toBe(true);
    expect(ready.test("Starting Metro Bundler")).toBe(false);
  });

  test("an unknown framework is an actionable error naming pithy ui list", () => {
    try {
      resolveStub("svelte");
      expect.unreachable("expected an unknown framework to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      const payload = (error as PithyError).payload;
      expect(payload.message).toContain("svelte");
      expect(payload.action).toContain("pithy ui list");
      expect(payload.action).toContain("Known: react, react-native.");
      // A name that matches nothing is the call's to fix, exit 2 (docs/CLI.md §3.8), not a missing resource.
      expect(payload.code).toBe("validation/invalid_input");
    }
  });
});
