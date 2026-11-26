// What counts towards the native "fingerprint" (app.json runtimeVersion policy: "fingerprint").
//
// An EAS Update only reaches a build whose runtime version (= fingerprint) matches exactly.
// By default the fingerprint also hashes things that never touch native code, so harmless
// changes silently cut TestFlight builds off from updates. That happened to build 9:
// adding npm scripts, a .gitignore line and the PostHog key changed the fingerprint, and
// two updates went to a runtime no installed build had.
//
// Skipped here (all JS-only or tooling):
//   - package.json scripts        (no script here runs during a native build)
//   - .gitignore
//   - app config `extra`          (keys read at runtime via expo-constants; an update
//                                  ships its own copy of `extra`)
//   - app config version fields + string runtimeVersion (Expo's own defaults)
//
// Native dependencies, config plugins and their options, permissions, icons and the rest of
// the app config are still hashed, so a real native change still needs a new build.
// Check before publishing an update:  npx eas-cli fingerprint:compare --build-id <build id>

/** @type {import('expo/fingerprint').Config} */
const config = {
  sourceSkips: [
    'ExpoConfigVersions',
    'ExpoConfigRuntimeVersionIfString',
    'PackageJsonScriptsAll',
    'GitIgnore',
    'ExpoConfigExtraSection',
  ],
};

module.exports = config;
