package expo.modules.systemvolume

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Android half of the volume bridge: read STREAM_MUSIC and report when it moves.
//
// There is no public callback for volume changes, so this listens for the
// undocumented-but-universal "android.media.VOLUME_CHANGED_ACTION" broadcast,
// which every OEM has emitted for years — and falls back to nothing worse than
// a fader that simply does not follow if some device ever stops sending it.
// The value is normalised to 0-1 so both platforms speak the same language.
class SystemVolumeModule : Module() {
  private var receiver: BroadcastReceiver? = null

  private val audio: AudioManager?
    get() = appContext.reactContext?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

  private fun currentVolume(): Float {
    val am = audio ?: return 1f
    val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
    if (max <= 0) return 1f
    return am.getStreamVolume(AudioManager.STREAM_MUSIC).toFloat() / max.toFloat()
  }

  override fun definition() = ModuleDefinition {
    Name("SystemVolume")

    Events("onVolumeChange")

    AsyncFunction("getVolume") {
      currentVolume()
    }

    OnStartObserving {
      val ctx = appContext.reactContext ?: return@OnStartObserving
      val r = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
          sendEvent("onVolumeChange", mapOf("volume" to currentVolume()))
        }
      }
      receiver = r
      ctx.registerReceiver(r, IntentFilter("android.media.VOLUME_CHANGED_ACTION"))
    }

    OnStopObserving {
      receiver?.let { r ->
        // Unregistering a receiver that was never registered throws; a device
        // that refused the filter would otherwise crash the app on teardown.
        runCatching { appContext.reactContext?.unregisterReceiver(r) }
      }
      receiver = null
    }

    OnDestroy {
      receiver?.let { r -> runCatching { appContext.reactContext?.unregisterReceiver(r) } }
      receiver = null
    }
  }
}
