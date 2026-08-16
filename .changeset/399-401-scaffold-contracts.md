---
"@pithy-sh/core": minor
"@pithy-sh/cli": patch
"@pithy-sh/ui-react": patch
---

Three contracts a scaffolded front end used to freeze in silence.

**`/health` is one statement.** It was written in four places — `createBackend` mounted it, the route allowlist seeded it, `pithy deploy`'s probe appended it, and the bare home screen fetched it — and nothing compared any pair. That screen is the only one a project with no auth composed gets, and its whole content is the request: a rename in the kit rendered *"The worker says: unknown."* with a 200, no error, and nothing in a log. `HEALTH_PATH` in `@pithy-sh/core/src/worker/health` is now the one statement all four read. It imports nothing, so the client bundle can hold it without a server runtime.

**The paths frozen at scaffold are checked by resolving them.** `vite.config.ts`'s `persistState` depth, both tsconfigs' `tsBuildInfoFile`, and `tsconfig.client.json`'s `include` are all relative to `apps/<worker>/`, and every one of them reads identically whether it is right or wrong. A wrong depth gives two Workers separate copies of one database. A narrowed `include` makes `tsc -b` exit 0 over a program holding no screens — the client's whole typecheck, gone, with no change in output. The gates live in the scaffolder's suite now, where a real project exists to resolve against, and each was proven red by planting the defect in one.

**The unstyled report can fail a run, and runs again.** It checked whether Pithy's screens render styled, then printed once at `pithy ui add` and never asked again — while `styles.css` is the adopter's, so the ordinary way a screen loses its rules is an edit a week later. `pithy ui sync` re-runs it and `--check` exits 1 on a finding, alongside the shadowed-route check it already made. It reads every `.css` under `src/` rather than the paths a run planned, so a rule in a stylesheet Pithy never wrote counts. `docs/UI.md` says when it runs, what fails, and the one blind spot it keeps: a `className` given a bare identifier is not read.
