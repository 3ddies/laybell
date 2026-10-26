const { withProjectBuildGradle } = require('@expo/config-plugins');

// A recently-published BETA of androidx.mediarouter (1.9.0-beta01) started getting
// pulled transitively — react-native-google-cast → play-services-cast-framework uses a
// dynamic '+' version, so the resolver drifted onto it — and that beta demands
// compileSdk 37 + Android Gradle Plugin 9.1, which Expo SDK 54 does not ship. That
// broke the Android RELEASE build at :app:checkReleaseAarMetadata (the iOS build is
// unaffected). This forces mediarouter back to the last stable line so Cast resolves to
// something that builds. Pure build fix — no app behaviour change, Cast still works.
module.exports = function withMediaRouterPin(config) {
  return withProjectBuildGradle(config, (cfg) => {
    const marker = '// laybell: pin mediarouter';
    if (cfg.modResults.contents.includes(marker)) return cfg;
    cfg.modResults.contents += `
${marker}
allprojects {
  configurations.all {
    resolutionStrategy {
      force 'androidx.mediarouter:mediarouter:1.7.0'
    }
  }
}
`;
    return cfg;
  });
};
