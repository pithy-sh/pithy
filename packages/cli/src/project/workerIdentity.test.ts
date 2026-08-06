// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { workerIdentity } from "./workerIdentity";

/**
 * The `--json` contract's two names for one Worker.
 *
 * Every fixture here gives the project and the worker **different** names, and that is the whole design
 * of this file rather than a stylistic preference. A Worker deploys as `<project>-<worker>`, so a fixture
 * built on `pithy-app` + `api` produces `pithy-app-api` and `api` — two strings that no assertion can
 * confuse, but also two that a *wrong* implementation still separates. The dangerous fixture is the one
 * where the names coincide: the directory and the deployed name collapse into the same value, every
 * assertion passes whichever field the code returns, and the bug is invisible. That is precisely how
 * pithy-sh/pithy#136 survived a green suite.
 */
describe("workerIdentity", () => {
  test("names the directory as `worker` and the deployed script as `deployedAs`", () => {
    expect(workerIdentity({ name: "dash-board", dir: "/repo/apps/board" })).toEqual({
      worker: "board",
      deployedAs: "dash-board",
    });
  });

  test("keeps the two apart when the deployed name merely starts with the directory", () => {
    // `board` and `board-worker` share a prefix. A `startsWith`/`replace` implementation reading the
    // deployed name would answer `-worker` or `board-worker` here; only reading the directory is right.
    expect(workerIdentity({ name: "board-worker", dir: "/repo/apps/board" })).toEqual({
      worker: "board",
      deployedAs: "board-worker",
    });
  });

  test("reads the directory, not the deployed name, when they disagree entirely", () => {
    // A `wrangler.jsonc` may name the Worker anything at all — it is not required to derive from the
    // directory, and `pithy worker rename` can leave the two unrelated.
    expect(workerIdentity({ name: "totally-unrelated", dir: "/repo/apps/board" })).toEqual({
      worker: "board",
      deployedAs: "totally-unrelated",
    });
  });

  test("ignores a trailing separator on the directory", () => {
    // `basename("/repo/apps/board/")` is `board` in Node, but the callers vary in whether they carry one
    // and an empty `worker` would be a silent, unreadable failure downstream.
    expect(workerIdentity({ name: "dash-board", dir: "/repo/apps/board/" }).worker).toBe("board");
  });

  test("survives a fixture whose names coincide, without the two fields becoming interchangeable", () => {
    // The collapsed case, asserted deliberately. Both fields are `api` here, which is exactly why no
    // other test in this file uses that shape.
    expect(workerIdentity({ name: "api", dir: "/repo/apps/api" })).toEqual({
      worker: "api",
      deployedAs: "api",
    });
  });
});
