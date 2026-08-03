// pithy.config.ts — your project's identity and policy.
//
// This file is project-wide. It deliberately does NOT list capabilities: what a
// Worker is made of is per-Worker, and lives in apps/<name>/pithy.config.ts.
// Only settings that cannot be per-Worker belong here.

const config = {
  // The project name, and the first segment of every name Pithy provisions:
  // <project>-<env>-<thing>, kebab-case, one rule for every namespace — D1, KV,
  // R2, Worker scripts, Workflows, Secrets Store entries, and Cloudflare API
  // tokens. A thing shared across environments puts the literal `global` in the
  // environment slot. Feature resources extend the same shape
  // (<project>-f<issue>-<slug>-<binding>-<kind>).
  //
  // Cloudflare's namespaces are flat and account-wide, so this segment is the
  // only thing keeping two projects in one account from adopting each other's
  // resources — and it is the only key teardown has to find them by. Renaming it
  // does not rename anything already provisioned: it orphans it, silently. Set it
  // once, keep it stable across machines and checkouts, and don't rename it.
  // `pithy doctor` checks that it still matches what your workers declare.
  name: "pithy-app",

  // Overrides for the predefined Cloudflare API token profiles (`pithy token`).
  // Account-level, so it lives here rather than on a Worker.
  // tokens: { overrides: {} },

  // `pithy seed` policy. `productionEnvironments` names every environment this
  // project treats as production, beyond the built-in production/prod — each one
  // requires the type-to-confirm phrase, not just --yes. A safety rule no single
  // Worker should be able to quietly omit.
  // seed: { includeExamples: false, productionEnvironments: ["live"] },
};

export default config;
