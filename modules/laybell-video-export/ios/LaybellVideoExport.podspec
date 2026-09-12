# Laybell's local native video exporter (see ../index.ts). Hand-written: a local
# module has no package.json to read a version from, and the create-expo-module
# local template is not used in this repo. The file name must equal s.name — the
# generated modules provider imports the pod by that name.
Pod::Spec.new do |s|
  s.name           = 'LaybellVideoExport'
  s.version        = '1.0.0'
  s.summary        = 'Writes a finished Laybell video: trim, song mix and caption overlays'
  s.description    = 'Local Expo module that exports an edited video with AVFoundation for saving to the camera roll'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '15.1'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
