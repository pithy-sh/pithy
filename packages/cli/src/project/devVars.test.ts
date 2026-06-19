import { describe, expect, test } from "vitest";
import { removeDevVarsContent, upsertDevVarsContent } from "./devVars";

describe("upsertDevVarsContent", () => {
  test("appends a new key to an empty file", () => {
    expect(upsertDevVarsContent("", { APP_TOKEN: "s" })).toBe("APP_TOKEN=s\n");
  });

  test("updates an existing key in place, preserving comments and other keys", () => {
    const before = "# creds\nCLOUDFLARE_ACCOUNT_ID=acct\nAPP_TOKEN=old\n";
    expect(upsertDevVarsContent(before, { APP_TOKEN: "new" })).toBe(
      "# creds\nCLOUDFLARE_ACCOUNT_ID=acct\nAPP_TOKEN=new\n",
    );
  });

  test("appends keys that are not present and updates ones that are, in one pass", () => {
    const before = "A=1\n";
    expect(upsertDevVarsContent(before, { A: "2", B: "3" })).toBe("A=2\nB=3\n");
  });

  test("collapses a duplicated key to a single line so the last-wins reader can't pick a stale value", () => {
    // parseDevVars takes the last occurrence; upsert must not leave an earlier-updated line shadowed.
    expect(upsertDevVarsContent("A=old1\nA=old2\n", { A: "new" })).toBe("A=new\n");
  });

  test("preserves a JSON-object value (the turnstile secret shape) verbatim", () => {
    const json = '{"visible":{"key":"1x0000"}}';
    expect(upsertDevVarsContent("", { "turnstile-secret-keys": json })).toBe(`turnstile-secret-keys=${json}\n`);
  });
});

describe("removeDevVarsContent", () => {
  test("drops only the named keys, keeping comments and others", () => {
    const before = "# creds\nA=1\nAPP_TOKEN=s\nB=2\n";
    expect(removeDevVarsContent(before, ["APP_TOKEN"])).toBe("# creds\nA=1\nB=2\n");
  });

  test("returns an empty string when the last key is removed", () => {
    expect(removeDevVarsContent("A=1\n", ["A"])).toBe("");
  });
});
