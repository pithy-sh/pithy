// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import {
  DEV_LOG_DIR_NAME,
  devLogBranch,
  devLogDir,
  devLogFile,
  devLogFileName,
  devLogSegment,
  parseDevLogFileName,
} from "./devLogPath";

/**
 * `PITHY_CONFIG_DIR` through the seam, never `process.env`: `stateDir` refuses the operator's own
 * directory under vitest, and a test that means a path should say which one.
 */
const paths = { env: { PITHY_CONFIG_DIR: "/cfg" }, platform: "linux" as const };

describe("devLogDir", () => {
  test("is <config>/<project>/logs/, the fourth kind of file under that root", () => {
    expect(devLogDir("acme", paths)).toBe(join("/cfg", "acme", DEV_LOG_DIR_NAME));
  });

  /**
   * The point of resolving through `projectConfigDir`: a name that could become two path segments is
   * refused by the one door that rule lives behind, rather than by a second copy of it here.
   */
  test("goes through projectConfigDir, so an unkebabbed project name is refused", () => {
    expect(() => devLogDir("My/Project", paths)).toThrow(ValidationError);
  });

  test("follows %APPDATA% on Windows, because that is the one branch a second implementation forgets", () => {
    expect(devLogDir("acme", { env: { APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, platform: "win32" })).toBe(
      join("C:\\Users\\a\\AppData\\Roaming", "pithy", "acme", "logs"),
    );
  });
});

describe("devLogSegment", () => {
  test("a path separator becomes a hyphen, so one segment stays one segment", () => {
    expect(devLogSegment("feature/671-dev-logs")).toBe("feature-671-dev-logs");
    expect(devLogSegment("a\\b")).toBe("a-b");
  });

  /**
   * **Windows is unverified in this project**, so the rule is kept by construction rather than by a test
   * on one platform: every character `CreateFile` rejects is replaced, whether or not this machine cares.
   */
  test("every character illegal in a Windows filename becomes a hyphen", () => {
    expect(devLogSegment('a<b>c:d"e|f?g*h')).toBe("a-b-c-d-e-f-g-h");
    expect(devLogSegment("a\u0000b\u001fc")).toBe("a-b-c");
  });

  test("a dot survives, because a Windows filename may hold one and a branch name does", () => {
    expect(devLogSegment("release/1.2")).toBe("release-1.2");
  });

  /** The documented loss: two branches that differ only in a separator share one file. */
  test("is lossy, and the collision is the documented one", () => {
    expect(devLogSegment("feature/a/b")).toBe(devLogSegment("feature-a-b"));
  });
});

describe("devLogBranch", () => {
  test("a detached HEAD has no name, so it files under one", () => {
    expect(devLogBranch(null)).toBe("detached");
    expect(devLogBranch(undefined)).toBe("detached");
    expect(devLogBranch("   ")).toBe("detached");
  });
});

describe("devLogFileName", () => {
  test("is dev.<branch>.<worker>.jsonl", () => {
    expect(devLogFileName("main", "api")).toBe("dev.main.api.jsonl");
  });

  test("the whole path is <config>/<project>/logs/dev.<branch>.<worker>.jsonl", () => {
    expect(devLogFile({ project: "acme", branch: "feature/671-x", worker: "email" }, paths)).toBe(
      join("/cfg", "acme", "logs", "dev.feature-671-x.email.jsonl"),
    );
  });

  /** Nothing goes into the checkout any more, which is the whole reason the path moved. */
  test("names no directory inside a checkout", () => {
    expect(devLogFile({ project: "acme", branch: "main", worker: "api" }, paths)).not.toContain("/proj");
  });
});

describe("parseDevLogFileName", () => {
  test("reads the branch and the worker back out", () => {
    expect(parseDevLogFileName("dev.main.api.jsonl")).toEqual({ branch: "main", worker: "api" });
  });

  /**
   * Split from the right, because a branch may hold a dot and a Worker name may not. Left-to-right would
   * hand `release` back as the branch of `release-1.2`.
   */
  test("a branch holding a dot still parses, because the split is from the right", () => {
    expect(parseDevLogFileName("dev.release-1.2.web.jsonl")).toEqual({ branch: "release-1.2", worker: "web" });
  });

  test("anything that is not one of ours is not one", () => {
    expect(parseDevLogFileName("dev.log")).toBeNull();
    expect(parseDevLogFileName("dev.main.jsonl")).toBeNull();
    expect(parseDevLogFileName("notes.main.api.jsonl")).toBeNull();
    expect(parseDevLogFileName("dev.main.api.json")).toBeNull();
  });
});
