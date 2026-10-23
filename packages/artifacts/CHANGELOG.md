# @pithy-sh/artifacts

## 0.2.0

### Minor Changes

- [#803](https://github.com/pithy-sh/pithy/pull/803) [`fc57559`](https://github.com/pithy-sh/pithy/commit/fc5755924da66f7b01c818084d21ff91ae10602c) Thanks [@kingmesal](https://github.com/kingmesal)! - Mark a field `pii`, `phi`, `secret`, or `pci` and it can no longer reach a log, an audit record, or an error detail — the call stops compiling, and `redact` gives you the masked view instead. Declare your classes with `pithy privacy enable` and `console` closes, deploys refuse to ship past it, and your control plane reports exactly which schemas and fields hold what — derived from the running code, so unmarking a field is a change leadership can see. `pithy privacy scan` suggests what to mark. It never decides for you.

### Patch Changes

- Updated dependencies [[`69b84a8`](https://github.com/pithy-sh/pithy/commit/69b84a8d9b9016969ff317825e398a739fb525c3), [`2ec361e`](https://github.com/pithy-sh/pithy/commit/2ec361e9ab36d3f9a2907e0d5ca14d78914e3d3b), [`fc57559`](https://github.com/pithy-sh/pithy/commit/fc5755924da66f7b01c818084d21ff91ae10602c)]:
  - @pithy-sh/core@0.12.0

## 0.1.0

### Minor Changes

- [#790](https://github.com/pithy-sh/pithy/pull/790) [`27d8d53`](https://github.com/pithy-sh/pithy/commit/27d8d5376b755f91496df325815f3239716e4de7) Thanks [@kingmesal](https://github.com/kingmesal)! - An app gives its own customers real git repositories, backed by Cloudflare Artifacts — owned by a person or an organization, read in the Worker or cloned over the wire, with short-lived tokens the kit mints against a grant you control.

### Patch Changes

- Updated dependencies [[`27d8d53`](https://github.com/pithy-sh/pithy/commit/27d8d5376b755f91496df325815f3239716e4de7), [`68bc375`](https://github.com/pithy-sh/pithy/commit/68bc3754d340acfd495fb8bd28466c27fd5ed1ba), [`5a8fc16`](https://github.com/pithy-sh/pithy/commit/5a8fc166fdfdc0c8a7b157a9b7f76fab2fcee7e6), [`dcb2d74`](https://github.com/pithy-sh/pithy/commit/dcb2d74b58a0ec7a6ca706b2608839d10d686862), [`f0a13c6`](https://github.com/pithy-sh/pithy/commit/f0a13c65956bf8f58e91c7751362bbcd5c57db04), [`6978c6d`](https://github.com/pithy-sh/pithy/commit/6978c6d10dc231a6f0b9fe114902433bc209f031), [`8b9c185`](https://github.com/pithy-sh/pithy/commit/8b9c185a6a9ca6f4a0cbfcdb89632cd0091fc65e), [`1c9c17d`](https://github.com/pithy-sh/pithy/commit/1c9c17d41cb1661cb86b5ad392bad70f5d786caf), [`fc5ccac`](https://github.com/pithy-sh/pithy/commit/fc5ccac1e8d19689216c8b97db9624bd0e5b6203), [`ae158a1`](https://github.com/pithy-sh/pithy/commit/ae158a1e3103577de9f9e3fb55d7727b4851ef54), [`61a99b9`](https://github.com/pithy-sh/pithy/commit/61a99b9457abaf150a4b0603b1ce597d1a72f489), [`e75c46c`](https://github.com/pithy-sh/pithy/commit/e75c46c5cea94b8f9175a68b5027324ba89a8155), [`1f6517f`](https://github.com/pithy-sh/pithy/commit/1f6517f82c431a61edbe05c46ebb2397fd529dd6), [`1fd60e4`](https://github.com/pithy-sh/pithy/commit/1fd60e43b8dc6947e1e12551981924725894f303), [`30c0c5a`](https://github.com/pithy-sh/pithy/commit/30c0c5ab52e89c535f4dd92d64a66320850480b8), [`e79ccba`](https://github.com/pithy-sh/pithy/commit/e79ccbab8a85dc3b51d0ffd13a082563aa548c9b)]:
  - @pithy-sh/core@0.11.0
