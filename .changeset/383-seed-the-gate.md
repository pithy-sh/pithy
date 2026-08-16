---
"@pithy-sh/ui-react": patch
"@pithy-sh/cli": patch
---

`pithy ui add --auth` now seeds the gate that catches the Turnstile action drifting, not just the widget it drifts in.

The action label is one contract with two ends. `#377` made the projection the single statement of it and had `src/turnstile.tsx` render `turnstileConfig.action`, and it proved that with a test — in `packages/ui-react/src/`. So the corrected widget shipped to adopters and the gate stayed here. The template's whole risk is that it can be retyped, it is an adopter-owned file the kit only seeds, and the kit cannot stop the retyping. That is exactly why the gate has to travel with it.

**The failure is invisible in every environment an adopter runs before production.** Cloudflare's always-pass test secret answers siteverify with no `action` field at all, and `#374` made the gate accept exactly that in dev and staging. A drift is caught first in production, where it refuses every sign-in with a 403 saying the challenge failed — pointing the reader at the sitekey, the secret and the widget, in that order, none of which is wrong. The adopter most likely to hit it was the one least equipped to recognise it.

`templates/src/turnstile.test.tsx` mocks `src/pithy-config.tsx` with an action that is deliberately not a real one, renders the widget against a stubbed `window.turnstile.render`, and asserts it carried the canary. **It cannot pass against a literal** — asserting the real action would pass against the very bug it exists to catch — and it derives nothing from its subject: the expected value is invented in the test file and reachable from nowhere else. A sitekey canary beside it fails as loudly when a mock never took effect as when the widget ignored it, and one assertion refuses the canary degenerating onto a real action, because a gate nobody can neuter quietly is worth more than one that only usually works.

It runs under the `vitest run` a scaffolded project already has. `// @vitest-environment happy-dom` in a docblock is the whole of its configuration — no Vite plugin, no alias, no kit package on the import path — because a gate that depends on the adopter's test configuration keeping a particular shape stops running the day they reshape it. `happy-dom` joins the React stub's dev dependencies to make that name resolve; the starter's node project already collects co-located `.tsx` tests but runs them in an environment with no `document`.

The kit runs it too, from the template tree, exactly as an adopter will. A gate shipped and never executed here is the same silence one level up.

`pithy ui add --auth` says the file is theirs and what it watches for, because a gate over a silence is worth nothing unnoticed.
