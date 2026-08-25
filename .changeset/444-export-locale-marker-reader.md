---
"@pithy-sh/core": minor
---

The locale marker's reader ships beside the marker.

`docs/I18N.md` publishes the line that declares a file is not English, so an adopter can teach their own prose census to read it. The reader was private — three functions inside a test file, in a package, that nothing could import — so every adopter with a spelling or pronoun census hand-ported them by reading a test.

`localeDeclared` and `valueSpans` are exported from `@pithy-sh/core/src/i18n/localeMarker` now, and `packages/cli/src/ci/americanEnglish.test.ts` consumes its own export, which is what stops the published marker and the shipped reader drifting apart.

The half that is easy to get wrong is documented at the export, because a porter reading the marker by eye gets it backwards: **the marker exempts the file's quoted values, not the file.** Prose outside quotes — docblocks, identifiers — is still censused, and `en` or `en-*` is a declaration and never an exemption. A census that read it as "skip this file" would silently stop reading the docblocks of every translated catalog it ever added.

The head window the guide states is now pinned to the window the reader reads, from both sides.
