// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { scratchGitEnv } from "./tempRepo";

describe("scratchGitEnv", () => {
  test("drops every variable that points git at another repository", () => {
    const env = scratchGitEnv({ GIT_DIR: "/r/.git", GIT_WORK_TREE: "/r", GIT_INDEX_FILE: "/r/.git/index", HOME: "/h" });

    expect(env).toEqual({ HOME: "/h" });
  });

  test("keeps the rest, git's own settings included", () => {
    const env = scratchGitEnv({ PATH: "/bin", GIT_AUTHOR_NAME: "A", GIT_CONFIG_NOSYSTEM: "1" });

    expect(env).toEqual({ PATH: "/bin", GIT_AUTHOR_NAME: "A", GIT_CONFIG_NOSYSTEM: "1" });
  });

  test("reads this process's environment when given none", () => {
    expect(scratchGitEnv().PATH).toBe(process.env.PATH);
  });
});
