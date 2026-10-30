# @pithy-sh/consent

## 0.1.1

### Patch Changes

- Updated dependencies [[`95122de`](https://github.com/pithy-sh/pithy/commit/95122dee96200ae3c01dffa2d6959be63efe01a1)]:
  - @pithy-sh/core@0.15.0

## 0.1.0

### Minor Changes

- [#858](https://github.com/pithy-sh/pithy/pull/858) [`7a1664c`](https://github.com/pithy-sh/pithy/commit/7a1664c445e6f84fc5ab55c1b30c8ec2e73fe426) Thanks [@kingmesal](https://github.com/kingmesal)! - Record consent the way a regulator asks to see it, from a checkbox to a signed authorization with its exact document and expiry, for visitors and accounts alike, and email's tracking and marketing mail follow it automatically.

- [#864](https://github.com/pithy-sh/pithy/pull/864) [`6521c97`](https://github.com/pithy-sh/pithy/commit/6521c97975d328dd2fd023e0a378e934348ea4ce) Thanks [@kingmesal](https://github.com/kingmesal)! - Your record of processing activities, the GDPR Article 30 document, now comes from your Worker: every purpose, the data it uses, its legal basis, who receives it, and how long it's kept.

- [#879](https://github.com/pithy-sh/pithy/pull/879) [`3bf6b34`](https://github.com/pithy-sh/pithy/commit/3bf6b3483ee1f6cbf1b8e9cd96f57a557b336ca1) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy ui add react-native` gives an Expo app the kit's screens, session and checkout on iOS, Android and the web, from one codebase.

### Patch Changes

- [#889](https://github.com/pithy-sh/pithy/pull/889) [`da603f4`](https://github.com/pithy-sh/pithy/commit/da603f47a0a96c4c7b8eaba2528c95021e6f9cef) Thanks [@kingmesal](https://github.com/kingmesal)! - A React Native app's web build uses the Turnstile sitekey of the environment it is built for, and the consent screens follow a custom consent base path on the web and on a phone.

- [#855](https://github.com/pithy-sh/pithy/pull/855) [`536284d`](https://github.com/pithy-sh/pithy/commit/536284d87ac654d28f5d2fcc14332cf0bb2b3d45) Thanks [@kingmesal](https://github.com/kingmesal)! - Every control-plane scope now says what kind of operation it is, so a management client can cap what an agent is granted, and a management client or `pithy dashboard connections --principal` can find and revoke everything one person authorized.
- Updated dependencies [[`a0330f0`](https://github.com/pithy-sh/pithy/commit/a0330f072bba28704301326f0b605e76a2fe6278), [`aa818f4`](https://github.com/pithy-sh/pithy/commit/aa818f4aac8ef6df09a074ff14b7dfc839606694), [`0eb6eab`](https://github.com/pithy-sh/pithy/commit/0eb6eab0df433d420cd95e0d27f0be4a6ec7c582), [`24b1744`](https://github.com/pithy-sh/pithy/commit/24b17441d5dc9e75e123bf2da631aa8e657f1e0e), [`b0bccd8`](https://github.com/pithy-sh/pithy/commit/b0bccd8fbfae8cc5750013341bc102f99afc57fa), [`7a1664c`](https://github.com/pithy-sh/pithy/commit/7a1664c445e6f84fc5ab55c1b30c8ec2e73fe426), [`536284d`](https://github.com/pithy-sh/pithy/commit/536284d87ac654d28f5d2fcc14332cf0bb2b3d45), [`204b5d5`](https://github.com/pithy-sh/pithy/commit/204b5d5a8f7a901a65a83eaecc6303196709fcdc), [`f04d818`](https://github.com/pithy-sh/pithy/commit/f04d818b2e498ddfc1b44eac707c51e7044634fb), [`df62262`](https://github.com/pithy-sh/pithy/commit/df622624dac2ad6b004b9e0d429ff1e701db3902), [`feb73e7`](https://github.com/pithy-sh/pithy/commit/feb73e7a55abe40485a689b5904430821e56f0c3), [`26bf2fe`](https://github.com/pithy-sh/pithy/commit/26bf2fed4e26b6c76d60f6c506c41e64ecbf6e0b), [`3a456ed`](https://github.com/pithy-sh/pithy/commit/3a456ed706627141ccfe270da09bcea0299e724d), [`2ca1808`](https://github.com/pithy-sh/pithy/commit/2ca18087e6ceba9cd4cc922df79559f4643f139e), [`97f7306`](https://github.com/pithy-sh/pithy/commit/97f73068fe9db8f2507590ac7c4fe7ef6b9dd16d), [`a51af92`](https://github.com/pithy-sh/pithy/commit/a51af92658b7dd8e3d2c6ef503d1647118240c78), [`13f8764`](https://github.com/pithy-sh/pithy/commit/13f876492403babf162d46207503832d4f61fb59), [`8c0081b`](https://github.com/pithy-sh/pithy/commit/8c0081be974673196052fadc7de1b455bb1bb523), [`6521c97`](https://github.com/pithy-sh/pithy/commit/6521c97975d328dd2fd023e0a378e934348ea4ce), [`3bf6b34`](https://github.com/pithy-sh/pithy/commit/3bf6b3483ee1f6cbf1b8e9cd96f57a557b336ca1), [`10eb7b1`](https://github.com/pithy-sh/pithy/commit/10eb7b1d5e1c61efbce076a31abd3f77021d59a7), [`536284d`](https://github.com/pithy-sh/pithy/commit/536284d87ac654d28f5d2fcc14332cf0bb2b3d45), [`1fcd6fb`](https://github.com/pithy-sh/pithy/commit/1fcd6fbae42500854f325c230ae5ea5c71813728)]:
  - @pithy-sh/core@0.14.0
