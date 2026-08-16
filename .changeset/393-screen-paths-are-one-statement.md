---
"@pithy-sh/ui-react": patch
"@pithy-sh/cli": patch
---

A screen's path and the router's redirect to it are one statement, not two literals that agree today.

`router.tsx` held `SIGN_IN_PATH = "/sign-in"` and `PAYWALL_PATH = "/paywall"`. The other end of each was an `export const path` in a different seeded file, typed `string`. Renaming `/sign-in` to `/login` — an ordinary rebrand, and the most predictable edit an adopter makes to a file that is now theirs — typechecked, linted, built, and left the signed-out guard redirecting to the not-found screen. Nobody already signed in would ever see it.

A screen claims the job it does — `export const role = "sign-in"` — and the router looks the path up. One statement, wherever the path moves to. Claim a role from `src/routes/app/` to take the job over, the same shadowing rule as a path. A role nothing claims throws, naming the export to add, rather than sending a visitor nowhere.

Seven sites carried a copy in all: the router's two, the magic link's `callbackURL`, `signOut`'s
redirect, and three `<Link to="…">` between screens. Each is now a role lookup or a declared export
read directly, and `react.test.ts` refuses a template that writes a screen's path anywhere but on the
line that exports it.

The magic link is the same contract in the other direction. `sign-in.tsx` built `` `${origin}/callback` `` while `callback.tsx` declared `/callback`, and the kit's own `signIn.test.tsx` asserted a literal against a literal it also owned — so the round trip breaking was entirely unobserved by the test that looked like it covered it. The screen reads the export now, and both tests read it too.

**Two gates are seeded with the screens (#391).** `src/router.test.tsx` and `src/routes/pithy/sign-in.test.tsx` travel into the repository where the rename actually happens. Each meets #383's three properties: the failure it watches is silent, its expectation is a canary invented in the test file with a second assertion refusing a canary that has drifted onto a real path, and each was proven able to fail in a scaffolded project by planting the literal it exists to refuse.
