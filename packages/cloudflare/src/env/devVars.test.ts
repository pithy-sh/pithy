import { afterEach, describe, expect, test, vi } from "vitest";
import { loadCloudflareEnv, parseDevVars } from "./devVars";

describe("parseDevVars", () => {
  test("parses KEY=value lines, skipping comments and blanks", () => {
    const content = [
      "# a comment",
      "",
      "CLOUDFLARE_ACCOUNT_ID=acct-1",
      "  CLOUDFLARE_API_TOKEN = tok-2 ",
      "BAD LINE",
    ].join("\n");
    expect(parseDevVars(content)).toEqual({ CLOUDFLARE_ACCOUNT_ID: "acct-1", CLOUDFLARE_API_TOKEN: "tok-2" });
  });

  test("strips one layer of surrounding quotes and keeps `=` inside values", () => {
    expect(parseDevVars(`SECRETS_STORE_ID="store=abc"`)).toEqual({ SECRETS_STORE_ID: "store=abc" });
  });
});

describe("loadCloudflareEnv", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("falls back to process.env for CF keys when no .dev.vars file is present", () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "from-env-acct");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "from-env-token");
    vi.stubEnv("SECRETS_STORE_ID", "from-env-store");

    // A directory with no .dev.vars — the read fails and the env overlay supplies the creds.
    const vars = loadCloudflareEnv("/nonexistent-pithy-dir");
    expect(vars).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "from-env-acct",
      CLOUDFLARE_API_TOKEN: "from-env-token",
      SECRETS_STORE_ID: "from-env-store",
    });
  });
});
