import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Cloudflare credential keys pithy reads out-of-Worker (CLI, provisioning, live tests). These are
 * wrangler's own env-var names plus the Secrets Store id. From this single bootstrap token
 * (`CLOUDFLARE_API_TOKEN`) pithy **mints** the scoped, least-privilege tokens each use case needs —
 * most notably the secrets manager's runtime token, minted at provision time and written straight into
 * the Secrets Store, so no scoped token is ever supplied or kept here.
 */
export const CLOUDFLARE_ENV_KEYS = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "SECRETS_STORE_ID",
  "R2_CREDENTIALS",
] as const;

/**
 * Parse a `.dev.vars` file body into a map: `KEY=value` lines, `#` comments and blanks skipped, and
 * a single layer of surrounding quotes stripped. Pure — the caller owns the file read.
 */
export function parseDevVars(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return vars;
}

/**
 * Load Cloudflare credentials for out-of-Worker use: parse `<dir>/.dev.vars` if it exists, then
 * overlay `process.env` for any {@link CLOUDFLARE_ENV_KEYS} the file did not set — so CI can pass them
 * as plain environment variables (e.g. GitHub Actions secrets) with no `.dev.vars` file present. A
 * missing or unreadable file is not an error; the environment overlay still applies.
 */
export function loadCloudflareEnv(dir: string): Record<string, string> {
  let vars: Record<string, string> = {};
  try {
    vars = parseDevVars(readFileSync(join(dir, ".dev.vars"), "utf8"));
  } catch {
    // No file — rely on the environment overlay below.
  }
  for (const key of CLOUDFLARE_ENV_KEYS) {
    const fromEnv = process.env[key];
    if (!vars[key] && fromEnv) vars[key] = fromEnv;
  }
  return vars;
}
