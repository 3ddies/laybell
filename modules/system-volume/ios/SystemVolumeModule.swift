import ExpoModulesCore
import AVFoundation

// Reads the device's output volume and reports when the hardware buttons move
// it, so an in-app fader can follow the side of the phone instead of fighting it.
//
// AVAudioSession.outputVolume is the only public way to read this on iOS; the
// documented way to observe it is KVO on that key path. It is READ-ONLY on
// purpose — Apple gives no supported API to set the system volume, and the old
// MPVolumeView slider trick is exactly the kind of thing that gets an app
// rejected. So the contract here is one-way: hardware moves the app, never the
// reverse.
//
// One thing worth knowing about the value: while a studio session is open the
// session category is playAndRecord, and in that mode the buttons drive the
// CALL volume, whose lowest step is still audible. That is an OS behaviour, not
// something this module can change — which is why the app keeps its own gain
// curve underneath this number rather than trusting it to reach silence.
public class SystemVolumeModule: Module {
  private var observation: NSKeyValueObservation?

  public func definition() -> ModuleDefinition {
    Name("SystemVolume")

    Events("onVolumeChange")

    AsyncFunction("getVolume") { () -> Float in
      // The session has to be active for outputVolume to be meaningful. In this
      // app LiveKit has already activated it; activating again is a no-op and
      // keeps the module honest when it is used anywhere else.
      let session = AVAudioSession.sharedInstance()
      try? session.setActive(true)
      return session.outputVolume
    }

    OnStartObserving {
      let session = AVAudioSession.sharedInstance()
      try? session.setActive(true)
      self.observation = session.observe(\.outputVolume, options: [.new]) { [weak self] _, change in
        guard let value = change.newValue else { return }
        self?.sendEvent("onVolumeChange", ["volume": value])
      }
    }

    OnStopObserving {
      self.observation?.invalidate()
      self.observation = nil
    }

    OnDestroy {
      self.observation?.invalidate()
      self.observation = nil
    }
  }
}
