---
"@pithy-sh/cli": patch
"@pithy-sh/auth": patch
"@pithy-sh/payments": patch
"@pithy-sh/support": patch
---

`pithy secrets ls` and `pithy doctor` stop asking for credentials the configuration has turned off.

One `doctor` run contradicted itself: it reported `SUPPORT_BUCKET (r2) declined in pithy.config.ts — Attachments are off, so nothing would ever be written to it`, and then asked for the R2 credential whose only purpose is reaching that bucket. Elsewhere it listed Apple and Facebook credentials for a project whose auth composes Google and GitHub and nothing else.

The list reads as a checklist, so an operator could not tell *not yet done* from *will never apply*, and every run re-raised the same settled questions. The prose softened it — *"fine to leave until you need it"* — but softening a line is not the same as not printing it, and *until you need it* is wrong for a credential the configuration has already refused. A report that lists things which cannot matter trains the reader to skim, which is what a bring-up checklist must not do.

A capability now declares which of its secrets its own configuration has put out of reach, and both surfaces read it. `auth` names a provider that is not enabled; `support` reuses the predicate that already suppresses the bucket binding, so the three settings behind it cannot drift from the credential; `payments` names the case where every rail is off.

**A credential is only hidden when nothing can reach it, and that question is asked per environment.** A provider gated on `compositionEnvironment() === "prod"` reads as disabled to a CLI that composes once with no environment stamped — so the fix, written naively, hides the credential production needs and drops it from the outstanding work. Applicability is therefore resolved once per declared environment and unioned: in reach anywhere is in reach. A configuration that will not load contributes a permissive answer rather than being skipped, because skipping narrows toward hiding.

The per-stanza check keeps its own answer. Where one Worker declines a binding and another does not, the credential is still outstanding for the second and silent for the first — a project-wide union alone would have printed, under the first Worker's own decline, a finding it could never close.
