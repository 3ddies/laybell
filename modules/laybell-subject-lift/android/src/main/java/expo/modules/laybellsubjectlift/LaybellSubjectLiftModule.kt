package expo.modules.laybellsubjectlift

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.segmentation.subject.SubjectSegmentation
import com.google.mlkit.vision.segmentation.subject.SubjectSegmenterOptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream

// Laybell's on-device subject lifter, Android (JS side: ../index.ts). ML Kit Subject
// Segmentation produces a FOREGROUND bitmap — the main subject(s) composited with a
// transparent background — which we write out as a PNG. On-device and free; the model
// downloads once via Google Play Services, then runs locally.

class LaybellSubjectLiftModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LaybellSubjectLift")

    // ML Kit handles model download at runtime; if Play Services is missing the process
    // call just fails and the JS side treats it as "no cutout".
    Function("isSupported") { true }

    AsyncFunction("liftSubject") { uri: String, outputUri: String, promise: Promise ->
      val ctx = appContext.reactContext
      if (ctx == null) {
        promise.reject(CodedException("no application context"))
        return@AsyncFunction
      }
      val src = loadBitmap(ctx, uri)
      if (src == null) {
        promise.reject(CodedException("could not read image"))
        return@AsyncFunction
      }
      try {
        val options = SubjectSegmenterOptions.Builder()
          .enableForegroundBitmap()
          .build()
        val segmenter = SubjectSegmentation.getClient(options)
        val input = InputImage.fromBitmap(src, 0)
        segmenter.process(input)
          .addOnSuccessListener { result ->
            val fg = result.foregroundBitmap
            if (fg == null) {
              promise.resolve(null) // no subject
              return@addOnSuccessListener
            }
            try {
              val out = fileFromUri(outputUri)
              FileOutputStream(out).use { fg.compress(Bitmap.CompressFormat.PNG, 100, it) }
              promise.resolve(Uri.fromFile(out).toString())
            } catch (e: Exception) {
              promise.reject(CodedException("could not write png: ${e.message}"))
            } finally {
              segmenter.close()
            }
          }
          .addOnFailureListener { e ->
            segmenter.close()
            promise.reject(CodedException("segmentation failed: ${e.message}"))
          }
      } catch (e: Exception) {
        promise.reject(CodedException(e.message ?: "subject lift failed"))
      }
    }
  }
}

private fun loadBitmap(ctx: Context, uri: String): Bitmap? {
  return try {
    val u = Uri.parse(uri)
    when (u.scheme) {
      null, "file" -> BitmapFactory.decodeFile(fileFromUri(uri).absolutePath)
      else -> ctx.contentResolver.openInputStream(u)?.use { BitmapFactory.decodeStream(it) }
    }
  } catch (e: Exception) {
    null
  }
}

private fun fileFromUri(uri: String): File {
  val u = Uri.parse(uri)
  return if (u.scheme == "file") File(u.path!!) else File(uri)
}
