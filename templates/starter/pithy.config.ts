// pithy.config.ts — your project's identity and policy.
//
// This file is project-wide. It deliberately does NOT list capabilities: what a
// Worker is made of is per-Worker, and lives in apps/<name>/pithy.config.ts.
// Only settings that cannot be per-Worker belong here.

const config = {
  // The project name. It is the first segment of every Cloudflare resource
  // `pithy feature` creates (<project>-f<issue>-<slug>-<binding>-<kind>), and the
  // only key teardown has to find them by — so it must stay stable across
  // machines and checkouts. Set it once; don't rename it casually.
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
