package expo.modules.laybellvideoexport

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Looper
import android.view.View
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.OverlaySettings
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.ChannelMixingAudioProcessor
import androidx.media3.common.audio.ChannelMixingMatrix
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.BitmapOverlay
import androidx.media3.effect.OverlayEffect
import androidx.media3.effect.Presentation
import androidx.media3.effect.StaticOverlaySettings
import androidx.media3.effect.TextureOverlay
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.Transformer
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.File
import java.io.FileOutputStream
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.concurrent.thread

// Laybell's native video exporter, Android (JS side: ../index.ts). Writes the FINISHED
// video a post was made with, for the camera roll: the posted window of the clip, the
// song mixed in at its part and levels, and the captions laid over it as full-frame
// images that each show for their own stretch. Everything here is Media3 Transformer
// 1.8.0 — the release expo-video and expo-audio pin in SDK 54.
//
// Nothing here can be compiled on the machine it was written on; every call was
// checked against the Media3 1.8.0 sources. Media3's effect APIs are @UnstableApi, so
// the classes that use them carry the same annotation, as expo-video's do.

// Every Record field has a default: Expo can build these without running initialisers.
class OverlayRecord : Record {
  @Field val uri: String = ""
  @Field val startSec: Double = 0.0
  @Field val endSec: Double = 0.0
}

class SongRecord : Record {
  @Field val uri: String = ""
  @Field val startSec: Double = 0.0
  @Field val volume: Double = 1.0
}

class ExportOptions : Record {
  @Field val videoUri: String = ""
  @Field val outputUri: String = ""
  @Field val startSec: Double = 0.0
  @Field val endSec: Double = 0.0
  @Field val width: Double = 0.0
  @Field val height: Double = 0.0
  @Field val videoVolume: Double = 1.0
  @Field val song: SongRecord? = null
  @Field val overlays: List<OverlayRecord> = emptyList()
  @Field val videoFit: String = "stretch"
}

class CaptureOptions : Record {
  @Field val viewTag: Int = 0
  @Field val width: Double = 0.0
  @Field val height: Double = 0.0
  @Field val outputUri: String = ""
}

private fun fileOf(uri: String): File =
  if (uri.startsWith("file:")) File(Uri.parse(uri).path ?: uri.removePrefix("file://")) else File(uri)

/** Whole even pixels, at least 2 — H.264 wants even dimensions. */
private fun even(value: Double): Int = max(2, (value.roundToInt() / 2) * 2)

/** A caption image and its stretch, in microseconds from the exported clip's start. */
private data class TimedPng(val path: String, val startUs: Long, val endUs: Long)

/**
 * All of a video's caption images as ONE overlay: Media3 allows at most 15 overlays per
 * OverlayEffect and samples every one on every pixel of every frame. It composes the
 * images showing at a timestamp into a single frame-sized bitmap, re-uploaded only when
 * that set changes (the same Bitmap object is returned; a new generation id triggers
 * the upload).
 *
 * The upload bitmap is un-premultiplied: GL receives the stored pixels as they are,
 * and Media3's shader blends them as straight alpha — premultiplied pixels would
 * darken every soft caption edge.
 */
@UnstableApi
private class TimedPngOverlay(
  private val pngs: List<TimedPng>,
  private val width: Int,
  private val height: Int,
) : BitmapOverlay() {
  private val scratch = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
  private val upload = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).apply { setPremultiplied(false) }
  private val pixels = IntArray(width * height)
  private val frame = Rect(0, 0, width, height)
  private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
  private val shown = StaticOverlaySettings.Builder().build()
  private val hidden = StaticOverlaySettings.Builder().setAlphaScale(0f).build()
  private var activeKey: String? = null

  private fun activeAt(timeUs: Long) = pngs.filter { timeUs >= it.startUs && timeUs < it.endUs }

  override fun getBitmap(presentationTimeUs: Long): Bitmap {
    val active = activeAt(presentationTimeUs)
    val key = active.joinToString("\n") { it.path }
    if (key != activeKey) {
      activeKey = key
      scratch.eraseColor(Color.TRANSPARENT)
      val canvas = Canvas(scratch)
      for (png in active) {
        val image = BitmapFactory.decodeFile(png.path) ?: continue
        canvas.drawBitmap(image, null, frame, paint)
        image.recycle()
      }
      scratch.getPixels(pixels, 0, width, 0, 0, width, height) // straight (un-premultiplied) ARGB
      upload.setPixels(pixels, 0, width, 0, 0, width, height)
    }
    return upload
  }

  override fun getOverlaySettings(presentationTimeUs: Long): OverlaySettings =
    if (activeAt(presentationTimeUs).isEmpty()) hidden else shown
}

/** A level for every channel count a clip or song may bring; a missing matrix throws. */
@UnstableApi
private fun volumeProcessor(volume: Float): AudioProcessor = ChannelMixingAudioProcessor().apply {
  putChannelMixingMatrix(ChannelMixingMatrix.createForConstantGain(1, 1).scaleBy(volume))
  putChannelMixingMatrix(ChannelMixingMatrix.createForConstantGain(2, 2).scaleBy(volume))
  for (channels in 3..6) {
    putChannelMixingMatrix(ChannelMixingMatrix.createForConstantPower(channels, 2).scaleBy(volume))
  }
}

@UnstableApi
class LaybellVideoExportModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  // One export at a time. Read and written only on the main thread, where the
  // Transformer lives and calls back.
  private var running: Transformer? = null

  override fun definition() = ModuleDefinition {
    Name("LaybellVideoExport")

    // Whether this build can fit a clip inside its frame (ExportOptions.videoFit) —
    // JS asks before saving a horizontal clip upright.
    Function("canFitVideo") {
      true
    }

    // The clip's display size (rotation applied) and length.
    AsyncFunction("getVideoInfo") { uri: String, promise: Promise ->
      val retriever = MediaMetadataRetriever()
      try {
        retriever.setDataSource(fileOf(uri).absolutePath)
        val width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
        val height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
        val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
        val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
        val sideways = rotation == 90 || rotation == 270
        promise.resolve(
          mapOf(
            "width" to (if (sideways) height else width).toDouble(),
            "height" to (if (sideways) width else height).toDouble(),
            "durationSec" to durationMs / 1000.0,
          )
        )
      } catch (e: Exception) {
        promise.reject("ERR_VIDEO_INFO", e.message, e)
      } finally {
        try {
          retriever.release()
        } catch (ignored: Exception) {
          // Already released, or the retriever never opened the file.
        }
      }
    }

    // Draws a mounted React Native view into a transparent PNG of exactly width x height
    // pixels — a saved video's caption image, drawn by the app's own caption renderer
    // (components/CaptionCaptureHost). View lookups must happen on the UI thread.
    AsyncFunction("captureView") { options: CaptureOptions, promise: Promise ->
      val view = try {
        appContext.findView<View>(options.viewTag)
      } catch (e: Exception) {
        null
      }
      if (view == null || view.width <= 0 || view.height <= 0) {
        promise.reject("ERR_VIEW_NOT_FOUND", "No laid-out view for tag ${options.viewTag}", null)
        return@AsyncFunction
      }
      try {
        val w = max(2, options.width.roundToInt())
        val h = max(2, options.height.roundToInt())
        val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.scale(w.toFloat() / view.width, h.toFloat() / view.height)
        view.draw(canvas)
        val file = fileOf(options.outputUri)
        // Drawn on the UI thread (it must be); encoded and written off it, so a video
        // with many caption images doesn't stutter the app.
        thread(name = "laybell-caption-png") {
          try {
            file.parentFile?.mkdirs()
            FileOutputStream(file).use { stream -> bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream) }
            promise.resolve(Uri.fromFile(file).toString())
          } catch (e: Exception) {
            promise.reject("ERR_CAPTURE", e.message, e)
          } finally {
            bitmap.recycle()
          }
        }
      } catch (e: Exception) {
        promise.reject("ERR_CAPTURE", e.message, e)
      }
    }.runOnQueue(Queues.MAIN)

    // Writes the finished video; resolves with the file's URI. Started on the main
    // thread, which is the Transformer's looper, so its callbacks arrive there too.
    AsyncFunction("exportVideo") { options: ExportOptions, promise: Promise ->
      if (running != null) {
        promise.reject("ERR_EXPORT_BUSY", "A video is already being saved", null)
        return@AsyncFunction
      }
      val output = fileOf(options.outputUri)
      try {
        output.parentFile?.mkdirs()
        if (output.exists()) output.delete()
        val composition = buildComposition(options, even(options.width), even(options.height))
        val transformer = Transformer.Builder(context)
          .setLooper(Looper.getMainLooper())
          .setVideoMimeType(MimeTypes.VIDEO_H264)
          .setAudioMimeType(MimeTypes.AUDIO_AAC)
          .addListener(object : Transformer.Listener {
            override fun onCompleted(composition: Composition, exportResult: ExportResult) {
              running = null
              promise.resolve(Uri.fromFile(output).toString())
            }

            override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
              running = null
              output.delete()
              promise.reject("ERR_EXPORT", exportException.message, exportException)
            }
          })
          .build()
        running = transformer
        transformer.start(composition, output.absolutePath)
      } catch (e: Exception) {
        running = null
        output.delete()
        promise.reject("ERR_EXPORT", e.message, e)
      }
    }.runOnQueue(Queues.MAIN)
  }

  private fun buildComposition(o: ExportOptions, width: Int, height: Int): Composition {
    // The posted window. Overlay timestamps count from 0 at its start.
    val startMs = (max(0.0, o.startSec) * 1000).toLong()
    val endMs = (o.endSec * 1000).toLong()
    val clipping = MediaItem.ClippingConfiguration.Builder().setStartPositionMs(startMs)
    if (endMs > startMs) clipping.setEndPositionMs(endMs)
    val video = MediaItem.Builder()
      .setUri(Uri.fromFile(fileOf(o.videoUri)))
      .setClippingConfiguration(clipping.build())
      .build()

    // Scale first, then the captions, so the frame-sized images line up exactly.
    // "stretch" fills the frame, whose shape is the clip's own give or take a pixel of
    // rounding; "contain" fits the clip inside it, centred, black around it — a
    // horizontal clip saved upright with its captions in the bands.
    val layout = if (o.videoFit == "contain") Presentation.LAYOUT_SCALE_TO_FIT else Presentation.LAYOUT_STRETCH_TO_FIT
    val videoEffects = mutableListOf<Effect>(
      Presentation.createForWidthAndHeight(width, height, layout)
    )
    val pngs = o.overlays
      .filter { it.uri.isNotEmpty() && it.endSec > it.startSec }
      .map { TimedPng(fileOf(it.uri).absolutePath, (max(0.0, it.startSec) * 1_000_000).toLong(), (it.endSec * 1_000_000).toLong()) }
    if (pngs.isNotEmpty()) {
      videoEffects += OverlayEffect(listOf<TextureOverlay>(TimedPngOverlay(pngs, width, height)))
    }

    // The clip's own sound at its level; left out entirely at 0.
    val dropAudio = o.videoVolume <= 0.0
    val audioProcessors =
      if (dropAudio) emptyList<AudioProcessor>() else listOf(volumeProcessor(min(1.0, o.videoVolume).toFloat()))
    val videoItem = EditedMediaItem.Builder(video)
      .setRemoveAudio(dropAudio)
      .setEffects(Effects(audioProcessors, videoEffects))
      .build()
    val sequences = mutableListOf(EditedMediaItemSequence.Builder(listOf(videoItem)).build())

    // The song from its part, as a looping sequence: the part repeats, and the whole
    // thing is cut where the clip ends — as the app plays it.
    val song = o.song
    if (song != null && song.uri.isNotEmpty() && song.volume > 0.0) {
      val songItem = MediaItem.Builder()
        .setUri(Uri.fromFile(fileOf(song.uri)))
        .setClippingConfiguration(
          MediaItem.ClippingConfiguration.Builder()
            .setStartPositionMs((max(0.0, song.startSec) * 1000).toLong())
            .build()
        )
        .build()
      // Audio only: a song file that carries a picture would otherwise send Transformer
      // down its multi-video compositing path.
      val songEdited = EditedMediaItem.Builder(songItem)
        .setRemoveVideo(true)
        .setEffects(Effects(listOf(volumeProcessor(min(1.0, song.volume).toFloat())), emptyList<Effect>()))
        .build()
      sequences += EditedMediaItemSequence.Builder(listOf(songEdited)).setIsLooping(true).build()
    }

    val builder = Composition.Builder(sequences)
    // An HDR clip would otherwise silently come out as HEVC HDR; tone mapping to SDR
    // keeps the saved file plain H.264 (API 29+).
    if (Build.VERSION.SDK_INT >= 29) {
      builder.setHdrMode(Composition.HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL)
    }
    return builder.build()
  }
}
