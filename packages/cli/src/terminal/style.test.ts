import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * `picocolors` decides color support once, at import. Re-import the module per
 * test with a stubbed env so each case sees its own terminal conditions.
 */
async function loadStyle(env: Record<string, string | undefined>): Promise<typeof import("./style")> {
  vi.resetModules();
  for (const key of ["NO_COLOR", "FORCE_COLOR", "COLORTERM"]) {
    vi.stubEnv(key, env[key]);
  }
  return await import("./style");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("saffron", () => {
  test("NO_COLOR returns the text unchanged", async () => {
    const { saffron } = await loadStyle({ NO_COLOR: "1", FORCE_COLOR: "1" });
    expect(saffron(".")).toBe(".");
  });

  test("truecolor terminals get the exact brand color (#D4A017)", async () => {
    const { saffron } = await loadStyle({ FORCE_COLOR: "1", COLORTERM: "truecolor" });
    expect(saffron(".")).toBe("\x1b[38;2;212;160;23m.\x1b[0m");
  });

  test("non-truecolor terminals fall back to 256-color 178", async () => {
    const { saffron } = await loadStyle({ FORCE_COLOR: "1", COLORTERM: undefined });
    expect(saffron(".")).toBe("\x1b[38;5;178m.\x1b[0m");
  });

  test("no color support returns the text unchanged", async () => {
    const { saffron } = await loadStyle({});
    expect(saffron(".")).toBe(".");
  });
});

describe("link", () => {
  test("wraps the text in an OSC-8 hyperlink when color is on", async () => {
    const { link } = await loadStyle({ FORCE_COLOR: "1" });
    expect(link("https://example.com", "id-123")).toBe("\x1b]8;;https://example.com\x1b\\id-123\x1b]8;;\x1b\\");
  });

  test("NO_COLOR returns the plain text (no escape sequence)", async () => {
    const { link } = await loadStyle({ NO_COLOR: "1", FORCE_COLOR: "1" });
    expect(link("https://example.com", "id-123")).toBe("id-123");
  });

  test("no color support returns the plain text", async () => {
    const { link } = await loadStyle({});
    expect(link("https://example.com", "id-123")).toBe("id-123");
  });
});

describe("supportsHyperlinks", () => {
  test("true when FORCE_COLOR is set", async () => {
    const { supportsHyperlinks } = await loadStyle({ FORCE_COLOR: "1" });
    expect(supportsHyperlinks()).toBe(true);
  });

  test("false when NO_COLOR is set", async () => {
    const { supportsHyperlinks } = await loadStyle({ NO_COLOR: "1", FORCE_COLOR: "1" });
    expect(supportsHyperlinks()).toBe(false);
  });

  test("false with no color support", async () => {
    const { supportsHyperlinks } = await loadStyle({});
    expect(supportsHyperlinks()).toBe(false);
  });
});
