// pithy.config.ts — the backend you own.
//
// This file is the entire user-owned surface. Logic lives in @pithy-sh/* packages
// and upgrades with them; this file only says what your backend is made of.

import { defineCapability } from "@pithy-sh/core/src/capability/capability";

// Your app is a capability like any other: routes, middleware, databases, KV
// namespaces, and the bindings they need. It composes last, after every
// library capability.
const app = defineCapability({
  // The app's capability name. Also its migration namespace once it has tables.
  name: "app",
  // Bindings your own routes need beyond what capabilities declare. Validated
  // on the first request — a missing binding fails fast with the binding's name.
  requiredBindings: [],
  // Mount your routes here. Every route declares how callers are verified —
  // bearer, session, signed-webhook, or public. `GET /health` is built in.
  // routes: (a) => {
  //   a.get("/hello", (c) => c.text("Hi."));
  // },
});

const config = {
  // Library capabilities, composed in order. `pithy add <capability>` registers
  // them here.
  capabilities: [
    // pithy:capabilities (managed region — do not remove this marker)
  ],
  app,
};

export default config;
