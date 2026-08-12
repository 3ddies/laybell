const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

// Builds the HaishinKit pod without the Swift performance optimizer.
//
// WHY. The first Release build of this app died compiling HaishinKit — the RTMP
// engine inside @api.video/react-native-livestream — and it was the COMPILER
// that crashed, not the code:
//
//   Apple Swift version 6.2
//   While running pass #18380 SILFunctionTransform "CopyPropagation"
//     on 'init(format:)' at Pods/HaishinKit/Sources/IO/AudioNode.swift:137
//   swift::LinearLifetimeChecker::ErrorBuilder::handleError → abort
//
// A SIL ownership-verifier assertion inside the optimizer. Nothing in this repo
// can express that differently, and no amount of app-side change avoids it.
//
// It had never shown up because every previous build was the DEVELOPMENT
// profile: Debug runs no SIL performance passes, so CopyPropagation never
// executed. It is not a regression — the Release path had simply never been
// built before.
//
// CopyPropagation is a performance pass, so -Onone skips it entirely. That makes
// this a precise fix rather than a hopeful one. Scoped to the single pod: every
// other target, including all of the app's own code, keeps full optimization.
//
// The cost is close to nothing in practice. HaishinKit's Swift is orchestration
// around VideoToolbox and AudioToolbox, which are C/Obj-C and unaffected — the
// encoding work does not happen in the code being deoptimized.
//
// REMOVE THIS when the pod (or Swift) moves past the bug. To check: delete the
// plugin from app.json, run a Release build, and see whether it still dies at
// AudioNode.swift.

const MARK = '# laybell:haishinkit-onone';

const SNIPPET = `
    ${MARK} — see plugins/withHaishinKitSwiftFix.js
    installer.pods_project.targets.each do |t|
      if t.name == 'HaishinKit'
        t.build_configurations.each do |bc|
          bc.build_settings['SWIFT_OPTIMIZATION_LEVEL'] = '-Onone'
        end
      end
    end
`;

module.exports = function withHaishinKitSwiftFix(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      let src = fs.readFileSync(podfile, 'utf8');

      if (src.includes(MARK)) return cfg; // already applied

      // CocoaPods honours exactly ONE post_install block, so this has to go
      // INSIDE the one Expo generates rather than adding a second.
      const anchor = /post_install do \|installer\|\n/;
      if (!anchor.test(src)) {
        throw new Error(
          '[withHaishinKitSwiftFix] No `post_install do |installer|` in the Podfile. '
          + 'Expo changed its template — re-point this plugin before building, or the '
          + 'HaishinKit Swift 6.2 optimizer crash comes back silently.',
        );
      }
      src = src.replace(anchor, (m) => m + SNIPPET);
      fs.writeFileSync(podfile, src);
      return cfg;
    },
  ]);
};
