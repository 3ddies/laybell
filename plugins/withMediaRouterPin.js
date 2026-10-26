const { withProjectBuildGradle } = require('@expo/config-plugins');

// react-native-google-cast pulls its Google Cast libraries with DYNAMIC '+' versions
// (`play-services-cast-framework:+`, which in turn drags in androidx.mediarouter), so the
// resolver keeps drifting onto brand-new releases that Expo SDK 54 cannot build:
//   • androidx.mediarouter 1.9.0-beta01 demands compileSdk 37 + AGP 9.1 (SDK 54 ships
//     neither) → broke the Android release at :app:checkReleaseAarMetadata.
//   • play-services-cast-framework 23.0.0 is compiled with Kotlin 2.4, whose binary
//     metadata SDK 54's Kotlin 2.1 refuses to read ("metadata is 2.4.0, expected 2.1.0")
//     → broke :app:compileReleaseKotlin.
// Pin BOTH back to the last stable line that builds. 21.5.0 is the newest cast-framework
// that is pure-Java (no kotlin-stdlib in its POM, so no Kotlin metadata at all), which
// makes it immune to the compiler-version error; it is contemporary with
// react-native-google-cast 4.9.1, so every Cast API it needs is present. The iOS build is
// unaffected by all of this. Pure build fix — no app behaviour change, Cast still works.
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
      force 'com.google.android.gms:play-services-cast-framework:21.5.0'
    }
  }
}
`;
    return cfg;
  });
};
