---
"@pithy-sh/cli": patch
"@pithy-sh/ui-react-native": patch
---

`pithy init --react-native` and `pithy ui add react-native` pin React to the version React Native's renderer requires, so a new Expo app launches and passes `expo-doctor`. An app scaffolded on 0.29.0 or earlier is fixed by `bunx expo install react@19.2.3 react-dom@19.2.3 @types/react@~19.2.4`, and `pithy doctor` now says so.
