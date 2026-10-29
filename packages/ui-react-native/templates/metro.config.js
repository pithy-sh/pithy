// Expo's Metro config, with the web build's way to the Worker under `pithy dev`: Metro serves the web build on its
// own port, and `metro-proxy.cjs` sends the calls meant for the Worker on to it.
const { getDefaultConfig } = require("expo/metro-config");
const { withDevProxy } = require("./metro-proxy.cjs");

module.exports = withDevProxy(getDefaultConfig(__dirname), __dirname);
