package com.soundsible.player.ui

import android.annotation.SuppressLint
import android.content.Context
import android.os.PowerManager

/**
 * CPU hold for page (WebView) playback.
 *
 * ExoPlayer manages its own wake lock; a WebView gets none from the system.
 * Without one, screen-off Doze starves the loopback audio the page is
 * decoding -- which reads from the lock screen as "no controls, no sound".
 * Acquired when the page reports playing, released on pause/stop/destroy.
 */
object WebPlaybackHold {
    private var lock: PowerManager.WakeLock? = null

    @SuppressLint("WakelockTimeout")
    @Synchronized
    fun setHeld(context: Context, held: Boolean) {
        if (held) {
            val current = lock
            if (current?.isHeld == true) return
            try {
                val manager = context.applicationContext.getSystemService(PowerManager::class.java)
                lock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Soundsible:web-playback").apply {
                    acquire()
                }
            } catch (_: Exception) {
            }
        } else {
            try {
                lock?.let { if (it.isHeld) it.release() }
            } catch (_: Exception) {
            }
            lock = null
        }
    }
}
