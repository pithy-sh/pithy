import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The Workers-runtime project: `*.workers.test.ts` runs inside workerd, against a real D1 database and
// a real KV namespace that Miniflare creates per run and throws away after. No mocks, no fakes.
//
// The bindings here are declared for the *test* runtime, not read from a Worker's wrangler.jsonc — one
// test run covers every Worker under apps/, and they do not all declare the same bindings.
// `pithy add <capability>` writes the capability's bindings into the Worker's wrangler.jsonc and the
// test bindings it declares into the miniflare options below, `pithy remove` takes out the ones nothing
// still composed declares, and `pithy doctor` names one missing.
// Bindings your own code needs are yours to add here.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-06-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        kvNamespaces: ["SESSIONS"],
      },
    }),
  ],
  test: {
    name: "workers",
    include: ["apps/*/src/**/*.workers.test.ts"],
  },
});
