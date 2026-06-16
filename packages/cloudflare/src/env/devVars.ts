import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Cloudflare credential keys pithy reads out-of-Worker (CLI, provisioning, live tests). These are
 * wrangler's own env-var names plus the Secrets Store id; a bootstrap token mints scoped tokens from here.
 *
 * `SECRETS_MANAGER_CLOUDFLARE_API_TOKEN` is distinct from the broad bootstrap `CLOUDFLARE_API_TOKEN`:
 * it is the **least-privilege** token written into the Secrets Store as the secrets manager's runtime
 * credential, scoped to **Secrets Store Read + Write only** (the manager's sole live-CF use is the
 * rotation config write-back; its D1 work runs through the `SECRETS` binding). Until `pithy` mints this
 * token itself, the operator supplies it here.
 */
export const CLOUDFLARE_ENV_KEYS = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "SECRETS_STORE_ID",
  "SECRETS_MANAGER_CLOUDFLARE_API_TOKEN",
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
