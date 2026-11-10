# Laybell's on-device subject lifter (see ../index.ts). Hand-written, like
# laybell-video-export: a local module has no package.json, and the create-expo-module
# local template isn't used here. The file name must equal s.name — the generated
# modules provider imports the pod by that name.
Pod::Spec.new do |s|
  s.name           = 'LaybellSubjectLift'
  s.version        = '1.0.0'
  s.summary        = 'Lift the subject out of a photo into a transparent sticker (on-device)'
  s.description    = 'Local Expo module: Vision VNGenerateForegroundInstanceMaskRequest (iOS 17+) cuts the subject out of an image as a transparent PNG.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '15.1'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
