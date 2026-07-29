import type { ClientProjection } from "@pithy-sh/core/src/capability/client";
import { describe, expect, test } from "vitest";
import {
  capabilityNameFromResolvedId,
  isResolvedVirtualId,
  RESOLVED_PREFIX,
  renderVirtualModule,
  resolveVirtualId,
  VIRTUAL_PREFIX,
} from "./virtualModule";

describe("resolveVirtualId", () => {
  test("maps a capability specifier to its NUL-prefixed resolved id", () => {
    expect(resolveVirtualId(`${VIRTUAL_PREFIX}auth`)).toBe(`${RESOLVED_PREFIX}auth`);
    expect(resolveVirtualId("virtual:pithy/matchmaking")).toBe("\0virtual:pithy/matchmaking");
  });

  test("accepts a hyphenated capability name", () => {
    expect(resolveVirtualId("virtual:pithy/rate-limit")).toBe("\0virtual:pithy/rate-limit");
  });

  test("returns null for an unrelated id", () => {
    expect(resolveVirtualId("react")).toBeNull();
    expect(resolveVirtualId("./router.tsx")).toBeNull();
    expect(resolveVirtualId("virtual:other/auth")).toBeNull();
    expect(resolveVirtualId("\0virtual:pithy/auth")).toBeNull();
  });

  test("declines an empty or multi-segment name rather than inventing a capability", () => {
    expect(resolveVirtualId("virtual:pithy/")).toBeNull();
    expect(resolveVirtualId("virtual:pithy/auth/session")).toBeNull();
    expect(resolveVirtualId("virtual:pithy/../secrets")).toBeNull();
  });
});

describe("capabilityNameFromResolvedId", () => {
  test("reads the name back off a resolved id", () => {
    expect(capabilityNameFromResolvedId("\0virtual:pithy/ledger")).toBe("ledger");
  });

  test("returns null for anything else", () => {
    expect(capabilityNameFromResolvedId("virtual:pithy/ledger")).toBeNull();
    expect(capabilityNameFromResolvedId("\0virtual:pithy/")).toBeNull();
    expect(capabilityNameFromResolvedId("/src/client.tsx")).toBeNull();
  });

  test("isResolvedVirtualId agrees", () => {
    expect(isResolvedVirtualId("\0virtual:pithy/auth")).toBe(true);
    expect(isResolvedVirtualId("\0other")).toBe(false);
  });
});

describe("renderVirtualModule", () => {
  test("emits a default export and one named export per key", () => {
    const code = renderVirtualModule({ enabled: true, otpLength: 6 } as ClientProjection);
    expect(code).toContain('export default {"enabled":true,"otpLength":6};');
    expect(code).toContain("export const enabled = true;");
    expect(code).toContain("export const otpLength = 6;");
  });

  test("emits nested JSON verbatim", () => {
    const code = renderVirtualModule({ enabled: true, providers: ["magic-link", "otp"] } as ClientProjection);
    expect(code).toContain('export const providers = ["magic-link","otp"];');
  });

  test("keeps a non-identifier key on the default export but skips its named export", () => {
    const code = renderVirtualModule({ enabled: false, "sign-in": "/auth/sign-in" } as ClientProjection);
    expect(code).toContain('"sign-in":"/auth/sign-in"');
    expect(code).not.toContain("export const sign-in");
  });

  test("skips a reserved word, which is a legal key but not a legal binding", () => {
    const code = renderVirtualModule({ enabled: true, default: 1, class: 2 } as ClientProjection);
    expect(code).toContain('"default":1');
    expect(code).not.toContain("export const default");
    expect(code).not.toContain("export const class");
  });

  test("the disabled projection is a valid module on its own", () => {
    expect(renderVirtualModule({ enabled: false })).toBe(
      'export default {"enabled":false};\nexport const enabled = false;\n',
    );
  });
});
