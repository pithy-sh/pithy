// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { envStem, originVarName } from "./stem";

describe("envStem", () => {
  test("uppercases and collapses non-alphanumerics", () => {
    expect(envStem("api")).toBe("API");
    expect(envStem("media-cli")).toBe("MEDIA_CLI");
  });

  test("collapses a run of separators to one underscore, and trims the ends", () => {
    expect(envStem("-web--app.")).toBe("WEB_APP");
  });

  test("leaves digits where they are, so a name is recoverable by eye", () => {
    expect(envStem("worker2")).toBe("WORKER2");
  });
});

describe("originVarName", () => {
  test("is the stem plus _ORIGIN — the name pithy dev writes and the runtime reads", () => {
    expect(originVarName("email")).toBe("EMAIL_ORIGIN");
    expect(originVarName("media-cli")).toBe("MEDIA_CLI_ORIGIN");
  });
});
