package com.soundsible.player.ui

import android.webkit.JavascriptInterface
import com.soundsible.player.SoundsibleApp
import com.soundsible.player.data.parseJsonObject
import com.soundsible.player.playback.ArtworkLoader
import com.soundsible.player.store.WebPlaybackPin

/**
 * Receives what the embedded web player is sounding so surfaces outside
 * the page (home-screen widget) follow it. The page calls
 * `window.SoundsibleNative.onTrackChanged(json)` from its media-session
 * projection; anywhere else the object simply does not exist.
 */
class SoundsibleNative(private val activity: LibraryActivity) {
    @JavascriptInterface
    fun onTrackChanged(json: String) {
        // Bridge calls arrive on a private thread: parsing and the artwork
        // fetch both happen here; the activity posts UI-visible state.
        var title = ""
        var artist = ""
        var album = ""
        var playing = true
        var cover: String? = null
        try {
            val payload = parseJsonObject(json)
            title = payload.optString("title", "")
            artist = payload.optString("artist", "")
            album = payload.optString("album", "")
            if (title.isEmpty()) {
                activity.runOnUiThread { activity.onWebNowPlaying("", "", "", false, null) }
                return
            }
            playing = payload.optBoolean("playing", true)
            val trackId = payload.optString("trackId", "")
            val positionMs = ((payload.optDouble("positionSec") ?: 0.0) * 1000).toLong().coerceAtLeast(0L)
            val durationMs = ((payload.optDouble("durationSec") ?: 0.0) * 1000).toLong().coerceAtLeast(0L)
            val app = activity.application as SoundsibleApp
            // Persist for resume-across-update before doing anything else:
            // an update can kill us mid-playback with no lifecycle callback.
            WebPlaybackPin.save(
                activity, trackId, title, artist, album,
                payload.optString("coverUrl", "").ifEmpty { null },
                positionMs, durationMs, playing,
            )
            val connection = app.tokenStore.load()
            cover = payload.optString("coverUrl", "").ifEmpty { null }
                ?.let { connection?.resolve(it) ?: it }
            val bitmap = cover?.let {
                ArtworkLoader.fetch(it, connection?.token)
            }
            val t = title
            val a = artist
            val al = album
            val p = playing
            activity.runOnUiThread {
                activity.onWebNowPlaying(t, a, al, p, bitmap)
            }
        } catch (_: Exception) {
        }
    }
}
