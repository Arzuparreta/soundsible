package com.soundsible.player.ui

import android.webkit.JavascriptInterface
import com.soundsible.player.data.parseJsonObject
import com.soundsible.player.widgets.SoundsibleWidgetProvider

/**
 * Receives what the embedded web player is sounding so surfaces outside
 * the page (home-screen widget) follow it. The page calls
 * `window.SoundsibleNative.onTrackChanged(json)` from its media-session
 * projection; anywhere else the object simply does not exist.
 */
class SoundsibleNative(private val activity: LibraryActivity) {
    @JavascriptInterface
    fun onTrackChanged(json: String) {
        try {
            val payload = parseJsonObject(json)
            val title = payload.optString("title", "")
            val artist = payload.optString("artist", "")
            if (title.isEmpty()) return
            SoundsibleWidgetProvider.updateAll(
                activity,
                title = title,
                subtitle = artist,
                isPlaying = payload.optBoolean("playing", true),
            )
        } catch (_: Exception) {
        }
    }
}
