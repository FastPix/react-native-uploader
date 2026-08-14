// Metro config for the standalone Expo example.
//
// The SDK is linked from the repo root via `file:../..`, so Metro must (1) watch
// the repo root to follow that link, and (2) force react / react-native and the
// SDK's native deps to a SINGLE copy — this example's own node_modules — so the
// linked SDK doesn't pull in a second copy of React Native.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "..", "..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [projectRoot, repoRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
];

// Any import of these — including from the linked SDK — resolves to this app's copy.
const singletons = [
  "react",
  "react-native",
  "react-native-blob-util",
  "@react-native-community/netinfo",
];
config.resolver.extraNodeModules = Object.fromEntries(
  singletons.map((name) => [
    name,
    path.resolve(projectRoot, "node_modules", name),
  ]),
);

module.exports = config;
