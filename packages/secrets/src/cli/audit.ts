/**
 * The `ls --check` audit. Compares the secrets the registry declares against what is actually
 * present in an environment, surfacing two problems:
 *
 *   - **missing** — a declared secret with no value in this env. The app needs it, so this is what
 *     the promote gate fails on (`ls --check --env production`): a newly-required secret must be set
 *     before production deploys against it.
 *   - **orphan** — a stored secret no longer in the registry. Harmless but worth cleaning up.
 *
 * Pure set logic — the caller gathers `expectedNames` (registry) and `presentNames` (the store's D1
 * metadata + bound CF Secrets Store entries) for the env.
 */
export interface AuditResult {
  missing: string[];
  orphan: string[];
}

export function auditSecrets(expectedNames: string[], presentNames: string[]): AuditResult {
  const present = new Set(presentNames);
  const expected = new Set(expectedNames);
  return {
    missing: [...expected].filter((name) => !present.has(name)).sort(),
    orphan: [...present].filter((name) => !expected.has(name)).sort(),
  };
}

/** The promote gate: an env is promotable only when no declared secret is missing a value. */
export function passesPromoteGate(audit: AuditResult): boolean {
  return audit.missing.length === 0;
}
