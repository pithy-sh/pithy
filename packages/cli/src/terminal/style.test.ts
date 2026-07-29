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

/**
 * `safe()` is the guard against ANSI injection, and the reason `link` sanitizes at all: both halves
 * of a hyperlink are values read out of a project's `wrangler.jsonc` — a resource id and a URL built
 * from it — so an embedded ESC could terminate this OSC-8 sequence early and open its own, rendering
 * a link that opens somewhere other than what it displays. Without the stripping these cases emit an
 * attacker-controlled target, so they are what holds that guard in place.
 */
describe("link strips control characters", () => {
  const ESC = "\x1b";

  test("an ESC in the url cannot terminate the sequence and open another", async () => {
    const { link } = await loadStyle({ FORCE_COLOR: "1" });
    const out = link(`https://example.com${ESC}]8;;https://evil.test${ESC}\\`, "id-123");
    // Only link's own four ESCs survive: the opener, the separator, and the closing pair.
    expect([...out].filter((c) => c === ESC)).toHaveLength(4);
    expect(out).not.toContain(`${ESC}]8;;https://evil.test`);
  });

  test("an ESC in the link text is stripped too", async () => {
    const { link } = await loadStyle({ FORCE_COLOR: "1" });
    const out = link("https://example.com", `id-123${ESC}]8;;https://evil.test${ESC}\\`);
    expect([...out].filter((c) => c === ESC)).toHaveLength(4);
    expect(out).not.toContain(`${ESC}]8;;https://evil.test`);
  });

  test("C0 and C1 control characters go, printable characters stay", async () => {
    const { link } = await loadStyle({ FORCE_COLOR: "1" });
    expect(link("https://example.com", `a${ESC}b\x00c\x07d\x7fe\x9bf`)).toContain("abcdef");
  });

  test("the no-color path sanitizes the text it returns", async () => {
    const { link } = await loadStyle({ NO_COLOR: "1", FORCE_COLOR: "1" });
    expect(link("https://example.com", `id-123${ESC}]8;;https://evil.test${ESC}\\`)).toBe(
      "id-123]8;;https://evil.test\\",
    );
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
