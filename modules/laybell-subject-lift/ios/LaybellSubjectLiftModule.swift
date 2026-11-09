import ExpoModulesCore
import Vision
import CoreImage
import UIKit

// Laybell's on-device subject lifter, iOS (JS side: ../index.ts). Cuts the main subject
// out of a photo into a transparent PNG — the "make a sticker" magic. Uses Vision's
// VNGenerateForegroundInstanceMaskRequest, which is iOS 17+; older iOS reports
// unsupported and the app never offers the option there.
//
// Nothing here can be compiled on the machine it was written on; it keeps to a 15.1
// deployment target and gates the iOS 17 API behind #available.

final class SubjectLiftException: GenericException<String> {
  override var reason: String { param }
}

private func fileURL(_ uri: String) -> URL {
  if let url = URL(string: uri), url.scheme != nil {
    return url
  }
  return URL(fileURLWithPath: uri)
}

// UIImage orientation → the CGImagePropertyOrientation Vision expects, so a photo taken
// sideways is cut out upright.
private func cgOrientation(_ o: UIImage.Orientation) -> CGImagePropertyOrientation {
  switch o {
  case .up: return .up
  case .down: return .down
  case .left: return .left
  case .right: return .right
  case .upMirrored: return .upMirrored
  case .downMirrored: return .downMirrored
  case .leftMirrored: return .leftMirrored
  case .rightMirrored: return .rightMirrored
  @unknown default: return .up
  }
}

// Which instance sits under a normalized (top-left origin, 0...1) point, or nil for
// background. Vision's instanceMask is a one-component buffer whose pixel value is the
// instance index (0 = background), in the same oriented space as the cutout.
@available(iOS 17.0, *)
private func instanceIndex(at nx: Double, _ ny: Double, in observation: VNInstanceMaskObservation) -> Int? {
  let mask = observation.instanceMask
  guard CVPixelBufferLockBaseAddress(mask, .readOnly) == kCVReturnSuccess else { return nil }
  defer { CVPixelBufferUnlockBaseAddress(mask, .readOnly) }
  let w = CVPixelBufferGetWidth(mask)
  let h = CVPixelBufferGetHeight(mask)
  guard w > 0, h > 0, let base = CVPixelBufferGetBaseAddress(mask) else { return nil }
  let bpr = CVPixelBufferGetBytesPerRow(mask)
  let px = min(max(Int(nx * Double(w)), 0), w - 1)
  let py = min(max(Int(ny * Double(h)), 0), h - 1)
  let value = base.load(fromByteOffset: py * bpr + px, as: UInt8.self)
  return value > 0 ? Int(value) : nil
}

public class LaybellSubjectLiftModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LaybellSubjectLift")

    Function("isSupported") { () -> Bool in
      if #available(iOS 17.0, *) { return true }
      return false
    }

    // Heavy work off the JS thread. Resolves with a file:// PNG (transparent, cropped to
    // the subject), or nil when there's no subject or the OS is too old.
    AsyncFunction("liftSubject") { (uri: String, outputUri: String, pointX: Double, pointY: Double) -> String? in
      guard #available(iOS 17.0, *) else { return nil }

      guard let data = try? Data(contentsOf: fileURL(uri)),
            let image = UIImage(data: data),
            let cgImage = image.cgImage else {
        throw SubjectLiftException("could not read image")
      }

      let request = VNGenerateForegroundInstanceMaskRequest()
      let handler = VNImageRequestHandler(cgImage: cgImage, orientation: cgOrientation(image.imageOrientation))
      do {
        try handler.perform([request])
      } catch {
        throw SubjectLiftException("vision failed: \(error.localizedDescription)")
      }

      guard let result = request.results?.first, !result.allInstances.isEmpty else {
        return nil // no subject to cut out
      }

      // With a touch point on a subject, lift JUST that instance (different areas →
      // different stickers, like iOS's own subject lift). A point on the background —
      // or none given (pointX < 0) — falls back to every instance so the gesture
      // still yields a cutout.
      var instances = result.allInstances
      if pointX >= 0, pointY >= 0,
         let picked = instanceIndex(at: pointX, pointY, in: result),
         result.allInstances.contains(picked) {
        instances = IndexSet(integer: picked)
      }

      let pixelBuffer: CVPixelBuffer
      do {
        pixelBuffer = try result.generateMaskedImage(
          ofInstances: instances,
          from: handler,
          croppedToInstancesExtent: true
        )
      } catch {
        throw SubjectLiftException("could not generate cutout: \(error.localizedDescription)")
      }

      let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
      let ctx = CIContext()
      guard let outCG = ctx.createCGImage(ciImage, from: ciImage.extent) else {
        throw SubjectLiftException("could not render cutout")
      }
      guard let png = UIImage(cgImage: outCG).pngData() else {
        throw SubjectLiftException("could not encode png")
      }

      let outURL = fileURL(outputUri)
      try png.write(to: outURL, options: .atomic)
      return outURL.absoluteString
    }
  }
}
