---
"@pithy-sh/cli": patch
---

`pithy add` declares the packages its test bindings import at the root, so the Workers tests run after a clean install.
