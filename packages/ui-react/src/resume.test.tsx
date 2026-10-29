// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test, vi } from "vitest";
import { resumeQuery, resumeTarget } from "../templates/src/session";

// `session.tsx` reads the composed config at import; nothing here touches it.
vi.mock("../templates/src/pithy-config", () => ({ authConfig: { enabled: false, basePath: "/auth" } }));
vi.mock("../templates/src/router", () => ({ navigate: () => {}, routeTable: async () => ({}) }));

/**
 * **A sign-in resumes only a path on this origin.** The consent screen sends somebody to sign in carrying
 * the authorization request it stopped at, and the callback follows it with a document load. Anything that could
 * leave the origin would make every sign-in link an open redirect, so the reading refuses it.
 */
describe("resumeTarget", () => {
  test("reads a path on this origin", () => {
    expect(resumeTarget("?resume=%2Fauth%2Foauth2%2Fauthorize%3Fclient_id%3Dc1")).toBe(
      "/auth/oauth2/authorize?client_id=c1",
    );
  });

  test("refuses anything a browser would read as another host", () => {
    for (const target of [
      "https://evil.test/x",
      "//evil.test/x",
      "/\\evil.test/x",
      "javascript:alert(1)",
      "relative",
      // The URL parser drops ASCII tab, CR and LF before it reads a URL, so each of these is `//evil.test/x`.
      "/\t/evil.test/x",
      "/\n/evil.test/x",
      "/\r/evil.test/x",
      "/\t\\evil.test/x",
      "\t//evil.test/x",
    ]) {
      expect(resumeTarget(`?${new URLSearchParams({ resume: target })}`), target).toBeNull();
    }
  });

  test("answers the path as the browser will read it", () => {
    expect(resumeTarget("?resume=%2Fa%2F..%2Fb%3Fq%3D1%23h")).toBe("/b?q=1#h");
  });

  test("is null with nothing to resume", () => {
    expect(resumeTarget("")).toBeNull();
    expect(resumeTarget("?email=a%40b.c")).toBeNull();
  });
});

describe("resumeQuery", () => {
  test("carries a valid target onward, and nothing otherwise", () => {
    expect(resumeQuery("?resume=%2Fx")).toBe("?resume=%2Fx");
    expect(resumeQuery("?resume=https%3A%2F%2Fevil.test")).toBe("");
    expect(resumeQuery("")).toBe("");
  });
});
