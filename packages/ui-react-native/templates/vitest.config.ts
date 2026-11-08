import { nativeTestProject } from "@pithy-sh/ui-react-native/testing/vitest";
import { defineConfig } from "vitest/config";

// The app's screen tests, run by its `test` script. `nativeTestProject` renders React Native through
// `react-native-web` in happy-dom and swaps every native module the screens use for a stand-in a test can drive:
// import one from `@pithy-sh/ui-react-native/testing/<module>`, such as `testing/expo-secure-store`. Every stand-in
// starts each test empty. The root `vitest.config.ts` that `pithy init` writes leaves an app with its own config
// to it, because these tests cannot load in that file's plain-Node project.
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [nativeTestProject({ include: ["src/**/*.test.{ts,tsx}"] })],
  },
});
