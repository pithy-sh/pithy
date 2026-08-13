---
"@pithy-sh/cli": patch
---

`pithy provision --feature` states the shortfall instead of naming a command that does nothing.

Both modes defer the same `d1` secrets — they are sealed under a master key inside an environment's
secrets manager, and provisioning runs before the managers are deployed. Both were then told to run
`pithy secrets provision`. That command spans the environments the project *declares*, deploying a
manager into each; a branch is not declared and gets no manager, deliberately, so running it from a
feature worktree does nothing. An operator spent a command and learned nothing, which is the dead end
this area exists to remove.

`--env` is unchanged. `--feature` now says that a branch gets no manager, that no command creates these
for one, and that the environment comes up without them. No remedy is invented: every route to one was
checked, and each is either the per-branch manager #241 refused or a second writer for a store whose
whole premise is that only the manager writes it.

`--json` carries the distinction as `pendingSecretsRemedy` — the command, or `null`. A pipeline branches
on that rather than on the mode. The advice is chosen by a record total over the provisioning modes, so
a third mode fails the build rather than inheriting whichever branch came first.
