# @pithy-sh/artifacts

## 0.3.0

### Minor Changes

- [#846](https://github.com/pithy-sh/pithy/pull/846) [`c8425cb`](https://github.com/pithy-sh/pithy/commit/c8425cb5e36d0c2270616814edd373d8c2adb93c) Thanks [@kingmesal](https://github.com/kingmesal)! - A management client can see an app's git repositories, who holds a token to each and when it expires, and revoke one, with a reason and an audit event.

- [#843](https://github.com/pithy-sh/pithy/pull/843) [`13f8764`](https://github.com/pithy-sh/pithy/commit/13f876492403babf162d46207503832d4f61fb59) Thanks [@kingmesal](https://github.com/kingmesal)! - Every capability that holds rows about a person now erases them on a purge and answers for them in an export, or says it keeps them and why.

### Patch Changes

- [#868](https://github.com/pithy-sh/pithy/pull/868) [`4308d78`](https://github.com/pithy-sh/pithy/commit/4308d78535533b02f25847f5fb46d1b84968605a) Thanks [@kingmesal](https://github.com/kingmesal)! - The credential helper now takes an API key as documented, and the artifacts docs state, from a live test, what revoking every token reaches. Revoking one token through the control plane that the kit minted and that is already revoked or expired now answers `revoked: 0` rather than a 404.

- [#855](https://github.com/pithy-sh/pithy/pull/855) [`536284d`](https://github.com/pithy-sh/pithy/commit/536284d87ac654d28f5d2fcc14332cf0bb2b3d45) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy` now ships an MCP server, so an agent can administer your Pithy application through the same scoped, audited control-plane seam the dashboard uses, with its tools discovered from what your Worker composes, on your machine with its own key or in CI with no key at all.

- [#855](https://github.com/pithy-sh/pithy/pull/855) [`536284d`](https://github.com/pithy-sh/pithy/commit/536284d87ac654d28f5d2fcc14332cf0bb2b3d45) Thanks [@kingmesal](https://github.com/kingmesal)! - Every control-plane scope now says what kind of operation it is, so a management client can cap what an agent is granted, and a management client or `pithy dashboard connections --principal` can find and revoke everything one person authorized.
- Updated dependencies [[`a0330f0`](https://github.com/pithy-sh/pithy/commit/a0330f072bba28704301326f0b605e76a2fe6278), [`aa818f4`](https://github.com/pithy-sh/pithy/commit/aa818f4aac8ef6df09a074ff14b7dfc839606694), [`0eb6eab`](https://github.com/pithy-sh/pithy/commit/0eb6eab0df433d420cd95e0d27f0be4a6ec7c582), [`24b1744`](https://github.com/pithy-sh/pithy/commit/24b17441d5dc9e75e123bf2da631aa8e657f1e0e), [`b0bccd8`](https://github.com/pithy-sh/pithy/commit/b0bccd8fbfae8cc5750013341bc102f99afc57fa), [`7a1664c`](https://github.com/pithy-sh/pithy/commit/7a1664c445e6f84fc5ab55c1b30c8ec2e73fe426), [`536284d`](https://github.com/pithy-sh/pithy/commit/536284d87ac654d28f5d2fcc14332cf0bb2b3d45), [`204b5d5`](https://github.com/pithy-sh/pithy/commit/204b5d5a8f7a901a65a83eaecc6303196709fcdc), [`f04d818`](https://github.com/pithy-sh/pithy/commit/f04d818b2e498ddfc1b44eac707c51e7044634fb), [`df62262`](https://github.com/pithy-sh/pithy/commit/df622624dac2ad6b004b9e0d429ff1e701db3902), [`feb73e7`](https://github.com/pithy-sh/pithy/commit/feb73e7a55abe40485a689b5904430821e56f0c3), [`26bf2fe`](https://github.com/pithy-sh/pithy/commit/26bf2fed4e26b6c76d60f6c506c41e64ecbf6e0b), [`3a456ed`](https://github.com/pithy-sh/pithy/commit/3a456ed706627141ccfe270da09bcea0299e724d), [`2ca1808`](https://github.com/pithy-sh/pithy/commit/2ca18087e6ceba9cd4cc922df79559f4643f139e), [`97f7306`](https://github.com/pithy-sh/pithy/commit/97f73068fe9db8f2507590ac7c4fe7ef6b9dd16d), [`a51af92`](https://github.com/pithy-sh/pithy/commit/a51af92658b7dd8e3d2c6ef503d1647118240c78), [`13f8764`](https://github.com/pithy-sh/pithy/commit/13f876492403babf162d46207503832d4f61fb59), [`8c0081b`](https://github.com/pithy-sh/pithy/commit/8c0081be974673196052fadc7de1b455bb1bb523), [`6521c97`](https://github.com/pithy-sh/pithy/commit/6521c97975d328dd2fd023e0a378e934348ea4ce), [`3bf6b34`](https://github.com/pithy-sh/pithy/commit/3bf6b3483ee1f6cbf1b8e9cd96f57a557b336ca1), [`10eb7b1`](https://github.com/pithy-sh/pithy/commit/10eb7b1d5e1c61efbce076a31abd3f77021d59a7), [`536284d`](https://github.com/pithy-sh/pithy/commit/536284d87ac654d28f5d2fcc14332cf0bb2b3d45), [`1fcd6fb`](https://github.com/pithy-sh/pithy/commit/1fcd6fbae42500854f325c230ae5ea5c71813728)]:
  - @pithy-sh/core@0.14.0

## 0.2.1

### Patch Changes

- Updated dependencies [[`b9d0453`](https://github.com/pithy-sh/pithy/commit/b9d0453e25c61d80eece0d8a08ac9d25c8bbadea), [`4ea8960`](https://github.com/pithy-sh/pithy/commit/4ea8960e54418748aea3ac5864ec61c7573ce4a3), [`afe98cc`](https://github.com/pithy-sh/pithy/commit/afe98cc0686356fe7b5267cbc39ca452df0242b6), [`b576f58`](https://github.com/pithy-sh/pithy/commit/b576f58fcda3962faeae75ec04ec37f8c1947f41)]:
  - @pithy-sh/core@0.13.0

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
