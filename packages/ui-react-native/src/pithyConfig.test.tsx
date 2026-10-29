// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { appEnvironment, originFor } from "../templates/src/pithy-config";

const origins = { dev: "http://localhost:8787", staging: "https://staging.example.com", prod: null };

describe("appEnvironment", () => {
  test("is dev when the build names none, and the one it names otherwise", () => {
    expect(appEnvironment(undefined)).toBe("dev");
    expect(appEnvironment("")).toBe("dev");
    expect(appEnvironment("staging")).toBe("staging");
    expect(appEnvironment("prod")).toBe("prod");
  });

  test("a name that is not an environment is refused, naming the variable and the three it takes", () => {
    expect(() => appEnvironment("production")).toThrow(/EXPO_PUBLIC_PITHY_ENV.*"production".*dev, staging or prod/);
  });
});

describe("originFor", () => {
  test("is the origin of the environment the build names", () => {
    expect(originFor(origins, "staging", "ios")).toBe("https://staging.example.com");
    expect(originFor(origins, "dev", "ios")).toBe("http://localhost:8787");
    expect(originFor(origins, "dev", "web")).toBe("http://localhost:8787");
  });

  test("an Android emulator reaches this machine's loopback through 10.0.2.2", () => {
    expect(originFor(origins, "dev", "android")).toBe("http://10.0.2.2:8787");
    expect(originFor({ dev: "http://127.0.0.1:8791" }, "dev", "android")).toBe("http://10.0.2.2:8791");
    expect(originFor({ dev: "http://192.168.1.20:8787" }, "dev", "android")).toBe("http://192.168.1.20:8787");
  });

  test("an environment with no origin is refused, saying where to set one", () => {
    expect(() => originFor(origins, "prod", "ios")).toThrow(/origins\.prod.*pithy-config\.generated\.ts/);
    expect(() => originFor({ dev: "http://localhost:8787" }, "staging", "ios")).toThrow(/origins\.staging/);
  });

  test("a phone sends its bearer credential to staging and prod over https only", () => {
    const plain = { dev: "http://localhost:8787", staging: "http://staging.example.com", prod: "http://example.com" };
    expect(() => originFor(plain, "staging", "ios")).toThrow(/origins\.staging.*https/);
    expect(() => originFor(plain, "prod", "android")).toThrow(/origins\.prod.*https/);
    expect(originFor({ dev: "http://192.168.1.20:8787" }, "dev", "ios")).toBe("http://192.168.1.20:8787");
  });

  test("the web build calls relative paths, so it needs no origin and is not refused for want of one", () => {
    expect(originFor(origins, "prod", "web")).toBe("");
    expect(originFor({ dev: "http://localhost:8787" }, "staging", "web")).toBe("");
  });
});
