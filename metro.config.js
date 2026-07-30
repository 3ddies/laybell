// Metro config. This file exists ONLY so Sentry can attach Debug IDs to the
// bundle — without it, a crash report from a released build is a wall of
// minified frames like `a.b(c)` with no file or line.
//
// getSentryExpoConfig wraps Expo's getDefaultConfig and returns it unchanged
// apart from the source-map plumbing, so the project keeps every default. If a
// real customisation is ever needed, add it to `config` below rather than
// swapping this back to getDefaultConfig.
const { getSentryExpoConfig } = require('@sentry/react-native/metro');

const config = getSentryExpoConfig(__dirname);

module.exports = config;
