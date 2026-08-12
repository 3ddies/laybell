Pod::Spec.new do |s|
  s.name           = 'SystemVolume'
  s.version        = '1.0.0'
  s.summary        = 'Reads the device output volume so in-app faders can follow the hardware buttons.'
  s.description    = s.summary
  s.author         = 'Laybell LLC'
  s.homepage       = 'https://laybell.app'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  # A LOCAL module has no git remote. `create-expo-module --local` crashed
  # writing this file for exactly that reason (its template interpolates a
  # `repo` it never defines for local modules), so this podspec is hand-written.
  # CocoaPods only needs a source that resolves; the files come from :path.
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,swift}"
end
