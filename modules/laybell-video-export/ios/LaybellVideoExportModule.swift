import AVFoundation
import CoreImage
import ExpoModulesCore
import UIKit

// Laybell's native video exporter, iOS (JS side: ../index.ts). Writes the FINISHED
// video a post was made with, for the camera roll: the posted window of the clip, the
// song mixed in at its part and levels, and the captions laid over it as full-frame
// images that each show for their own stretch. AVFoundation, and Core Image for the
// captions.
//
// Nothing here can be compiled on the machine it was written on, so it keeps to APIs
// available since iOS 15 (the SDK 54 deployment target) and uses the iOS 18 export
// call only behind #available.

struct OverlayRecord: Record {
  @Field var uri: String = ""
  @Field var startSec: Double = 0
  @Field var endSec: Double = 0
}

struct SongRecord: Record {
  @Field var uri: String = ""
  @Field var startSec: Double = 0
  @Field var volume: Double = 1
}

struct ExportOptions: Record {
  @Field var videoUri: String = ""
  @Field var outputUri: String = ""
  @Field var startSec: Double = 0
  @Field var endSec: Double = 0
  @Field var width: Double = 0
  @Field var height: Double = 0
  @Field var videoVolume: Double = 1
  @Field var song: SongRecord?
  @Field var overlays: [OverlayRecord] = []
  @Field var videoFit: String = "stretch"
}

struct CaptureOptions: Record {
  @Field var viewTag: Int = 0
  @Field var width: Double = 0
  @Field var height: Double = 0
  @Field var outputUri: String = ""
}

final class VideoExportException: GenericException<String> {
  override var reason: String {
    param
  }
}

private func fileURL(_ uri: String) -> URL {
  if let url = URL(string: uri), url.scheme != nil {
    return url
  }
  return URL(fileURLWithPath: uri)
}

public class LaybellVideoExportModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LaybellVideoExport")

    // Whether this build can fit a clip inside its frame (ExportOptions.videoFit) —
    // JS asks before saving a horizontal clip upright.
    Function("canFitVideo") { () -> Bool in
      true
    }

    // The clip's display size (rotation applied) and length.
    AsyncFunction("getVideoInfo") { (uri: String, promise: Promise) in
      Task {
        do {
          let asset = AVURLAsset(url: fileURL(uri))
          guard let track = try await asset.loadTracks(withMediaType: .video).first else {
            throw VideoExportException("The file has no video track")
          }
          let (natural, transform) = try await track.load(.naturalSize, .preferredTransform)
          let duration = try await asset.load(.duration)
          let box = CGRect(origin: .zero, size: natural).applying(transform)
          let seconds = CMTimeGetSeconds(duration)
          promise.resolve([
            "width": Double(abs(box.width)),
            "height": Double(abs(box.height)),
            "durationSec": seconds.isFinite ? seconds : 0
          ])
        } catch {
          promise.reject(error)
        }
      }
    }

    // Draws a mounted React Native view into a transparent PNG of exactly width x height
    // pixels — a saved video's caption image, drawn by the app's own caption renderer
    // (components/CaptionCaptureHost). View lookups must happen on the main thread.
    AsyncFunction("captureView") { (options: CaptureOptions, promise: Promise) in
      guard let view = self.appContext?.findView(withTag: options.viewTag, ofType: UIView.self),
            view.bounds.width > 0, view.bounds.height > 0 else {
        promise.reject("ERR_VIEW_NOT_FOUND", "No laid-out view for tag \(options.viewTag)")
        return
      }
      let size = CGSize(width: max(2, options.width.rounded()), height: max(2, options.height.rounded()))
      let format = UIGraphicsImageRendererFormat.default()
      format.scale = 1
      format.opaque = false
      // 8-bit sRGB. A wide-colour phone otherwise draws in extended range and writes a
      // 16-bit PNG: several times the size, for captions that gain nothing from it.
      format.preferredRange = .standard
      let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
        let drawn = view.drawHierarchy(in: CGRect(origin: .zero, size: size), afterScreenUpdates: true)
        if !drawn {
          context.cgContext.scaleBy(x: size.width / view.bounds.width, y: size.height / view.bounds.height)
          view.layer.render(in: context.cgContext)
        }
      }
      // Drawn on the main thread (it must be); encoded and written off it, so a video
      // with many caption images doesn't stutter the app.
      let url = fileURL(options.outputUri)
      DispatchQueue.global(qos: .userInitiated).async {
        guard let data = image.pngData() else {
          promise.reject("ERR_CAPTURE", "Could not encode the caption image")
          return
        }
        do {
          try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
          try data.write(to: url, options: .atomic)
          promise.resolve(url.absoluteString)
        } catch {
          promise.reject(error)
        }
      }
    }.runOnQueue(.main)

    // Writes the finished video; resolves with the file's URI.
    AsyncFunction("exportVideo") { (options: ExportOptions, promise: Promise) in
      Task {
        do {
          let url = try await LaybellVideoExportModule.export(options)
          promise.resolve(url.absoluteString)
        } catch {
          promise.reject(error)
        }
      }
    }
  }

  private static func export(_ o: ExportOptions) async throws -> URL {
    let outputURL = fileURL(o.outputUri)
    let preciseTiming = [AVURLAssetPreferPreciseDurationAndTimingKey: true]
    let asset = AVURLAsset(url: fileURL(o.videoUri), options: preciseTiming)
    guard let sourceVideo = try await asset.loadTracks(withMediaType: .video).first else {
      throw VideoExportException("The clip has no video track")
    }
    let (natural, preferred, videoRange) = try await sourceVideo.load(.naturalSize, .preferredTransform, .timeRange)

    // The posted window.
    let start = CMTime(seconds: max(0, o.startSec), preferredTimescale: 600)
    let end = CMTimeMinimum(CMTime(seconds: o.endSec, preferredTimescale: 600), videoRange.end)
    guard CMTimeCompare(end, start) > 0 else {
      throw VideoExportException("The part to save is empty")
    }
    let clip = CMTimeRange(start: start, end: end)

    let composition = AVMutableComposition()
    guard let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
      throw VideoExportException("Could not prepare the video")
    }
    try videoTrack.insertTimeRange(clip, of: sourceVideo, at: .zero)

    // The clip's own sound, at its level; left out entirely at 0.
    var audioParameters: [AVMutableAudioMixInputParameters] = []
    if o.videoVolume > 0,
       let sourceAudio = try await asset.loadTracks(withMediaType: .audio).first,
       let audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
      let audioRange = clip.intersection(try await sourceAudio.load(.timeRange))
      if CMTimeCompare(audioRange.duration, .zero) > 0 {
        try audioTrack.insertTimeRange(audioRange, of: sourceAudio, at: CMTimeSubtract(audioRange.start, clip.start))
        let parameters = AVMutableAudioMixInputParameters(track: audioTrack)
        parameters.setVolume(Float(min(1, o.videoVolume)), at: .zero)
        audioParameters.append(parameters)
      } else {
        // The clip's sound doesn't reach the posted window: an empty track can fail the export.
        composition.removeTrack(audioTrack)
      }
    }

    // The song from its part, repeating that part until the clip ends — as the app
    // plays it — at its own level.
    if let song = o.song, song.volume > 0, !song.uri.isEmpty {
      let songAsset = AVURLAsset(url: fileURL(song.uri), options: preciseTiming)
      if let sourceSong = try await songAsset.loadTracks(withMediaType: .audio).first {
        let songRange = try await sourceSong.load(.timeRange)
        let part = CMTimeRange(
          start: CMTimeMaximum(songRange.start, CMTime(seconds: max(0, song.startSec), preferredTimescale: 600)),
          end: songRange.end
        )
        if CMTimeCompare(part.duration, .zero) > 0,
           let songTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
          var cursor = CMTime.zero
          var pieces = 0
          while CMTimeCompare(cursor, clip.duration) < 0 && pieces < 10_000 {
            let length = CMTimeMinimum(part.duration, CMTimeSubtract(clip.duration, cursor))
            try songTrack.insertTimeRange(CMTimeRange(start: part.start, duration: length), of: sourceSong, at: cursor)
            cursor = CMTimeAdd(cursor, length)
            pieces += 1
          }
          let parameters = AVMutableAudioMixInputParameters(track: songTrack)
          parameters.setVolume(Float(min(1, song.volume)), at: .zero)
          audioParameters.append(parameters)
        }
      }
    }

    // The picture, upright, in the size the caption images were drawn at: stretched to
    // the frame, whose shape is the clip's own give or take a pixel of rounding — or,
    // "contain", fitted inside it and centred with black around it (a horizontal clip
    // saved upright, its captions in the bands).
    let box = CGRect(origin: .zero, size: natural).applying(preferred)
    guard box.width > 0, box.height > 0 else {
      throw VideoExportException("The clip has no picture size")
    }
    let render = CGSize(width: max(2, o.width.rounded()), height: max(2, o.height.rounded()))
    let upright = preferred.concatenating(CGAffineTransform(translationX: -box.minX, y: -box.minY))
    let transform: CGAffineTransform
    if o.videoFit == "contain" {
      let fit = min(render.width / box.width, render.height / box.height)
      transform = upright
        .concatenating(CGAffineTransform(scaleX: fit, y: fit))
        .concatenating(CGAffineTransform(
          translationX: ((render.width - box.width * fit) / 2).rounded(),
          y: ((render.height - box.height * fit) / 2).rounded()
        ))
    } else {
      transform = upright.concatenating(CGAffineTransform(scaleX: render.width / box.width, y: render.height / box.height))
    }
    let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: videoTrack)
    layerInstruction.setTransform(transform, at: .zero)
    let instruction = AVMutableVideoCompositionInstruction()
    instruction.timeRange = CMTimeRange(start: .zero, duration: clip.duration)
    instruction.layerInstructions = [layerInstruction]

    let videoComposition = AVMutableVideoComposition()
    videoComposition.renderSize = render
    videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
    videoComposition.instructions = [instruction]
    videoComposition.colorPrimaries = AVVideoColorPrimaries_ITU_R_709_2
    videoComposition.colorTransferFunction = AVVideoTransferFunction_ITU_R_709_2
    videoComposition.colorYCbCrMatrix = AVVideoYCbCrMatrix_ITU_R_709_2

    // A fresh session every time: a session cannot export twice.
    guard let session = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
      throw VideoExportException("Could not start the export")
    }
    session.videoComposition = videoComposition
    if !audioParameters.isEmpty {
      let mix = AVMutableAudioMix()
      mix.inputParameters = audioParameters
      session.audioMix = mix
    }
    session.shouldOptimizeForNetworkUse = true

    // The captions go on in a second pass, over the finished picture. Laid on in this
    // pass with AVVideoCompositionCoreAnimationTool, every frame came out black, the
    // picture and the captions alike (dev build 847a40c8, 2026-09-11), while the same
    // export without it was right. Core Image over the picture file needs no layer tree.
    let overlays = o.overlays.filter { $0.endSec > $0.startSec && !$0.uri.isEmpty }
    if overlays.isEmpty {
      try await runExport(session, to: outputURL)
      return outputURL
    }
    let pictureURL = outputURL.deletingLastPathComponent()
      .appendingPathComponent(outputURL.deletingPathExtension().lastPathComponent + "-picture.mp4")
    defer { try? FileManager.default.removeItem(at: pictureURL) }
    try await runExport(session, to: pictureURL)
    try await addCaptions(overlays, over: pictureURL, writing: outputURL)
    return outputURL
  }

  /// Each caption image laid over an already finished video, for its own stretch. The
  /// picture is upright and at its final size there, the size the images were drawn at,
  /// so each frame only needs the images composited over it.
  private static func addCaptions(_ overlays: [OverlayRecord], over pictureURL: URL, writing outputURL: URL) async throws {
    let captions: [(image: CIImage, start: Double, end: Double)] = overlays.compactMap { overlay in
      guard let image = CIImage(contentsOf: fileURL(overlay.uri)) else { return nil }
      return (image, max(0, overlay.startSec), overlay.endSec)
    }
    if captions.isEmpty {
      try? FileManager.default.removeItem(at: outputURL)
      try FileManager.default.moveItem(at: pictureURL, to: outputURL)
      return
    }
    let asset = AVURLAsset(url: pictureURL, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
    let videoComposition = AVMutableVideoComposition(asset: asset, applyingCIFiltersWithHandler: { request in
      let frame = request.sourceImage
      let seconds = CMTimeGetSeconds(request.compositionTime)
      var output = frame
      for caption in captions where seconds >= caption.start && seconds < caption.end {
        output = caption.image.composited(over: output)
      }
      request.finish(with: output.cropped(to: frame.extent), context: nil)
    })
    videoComposition.colorPrimaries = AVVideoColorPrimaries_ITU_R_709_2
    videoComposition.colorTransferFunction = AVVideoTransferFunction_ITU_R_709_2
    videoComposition.colorYCbCrMatrix = AVVideoYCbCrMatrix_ITU_R_709_2
    guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetHighestQuality) else {
      throw VideoExportException("Could not start the caption pass")
    }
    session.videoComposition = videoComposition
    session.shouldOptimizeForNetworkUse = true
    try await runExport(session, to: outputURL)
  }

  /// Runs an export session into `url`, replacing whatever is there.
  private static func runExport(_ session: AVAssetExportSession, to url: URL) async throws {
    try? FileManager.default.removeItem(at: url)
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    if #available(iOS 18.0, *) {
      try await session.export(to: url, as: .mp4)
    } else {
      session.outputURL = url
      session.outputFileType = .mp4
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        session.exportAsynchronously {
          continuation.resume()
        }
      }
      if session.status != .completed {
        throw session.error ?? VideoExportException("The export did not finish")
      }
    }
  }
}
