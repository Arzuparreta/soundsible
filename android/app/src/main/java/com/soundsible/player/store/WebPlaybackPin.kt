package com.soundsible.player.store

import android.content.Context
import com.soundsible.player.data.JsonObject
import com.soundsible.player.data.parseJsonObject

/**
 * Persists what the web player is sounding: identity, artwork and position.
 * Written on every bridge report but throttled to disk (track change,
 * pause, or 15 s of continued playback), synchronously so an update
 * mid-playback cannot lose it. Survives updates: app-private storage is
 * preserved, and the stream URL is re-derived from the track id against
 * whatever port the engine took this boot.
 */
object WebPlaybackPin {
    private const val FILE = "web-last.json"
    private const val SAVE_INTERVAL_MS = 15_000L

    @Volatile private var lastTrackId: String? = null
    @Volatile private var lastWriteMs: Long = 0L

    data class Pinned(
        val trackId: String,
        val title: String,
        val artist: String,
        val album: String,
        val coverUrl: String?,
        val positionMs: Long,
        val durationMs: Long,
    )

    private fun file(context: Context): java.io.File =
        java.io.File(context.filesDir, "soundsible/$FILE")

    fun save(
        context: Context,
        trackId: String,
        title: String,
        artist: String,
        album: String,
        coverUrl: String?,
        positionMs: Long,
        durationMs: Long,
        playing: Boolean,
    ) {
        try {
            val now = System.currentTimeMillis()
            val trackChanged = trackId != lastTrackId
            if (!trackChanged && playing && now - lastWriteMs < SAVE_INTERVAL_MS) return
            lastTrackId = trackId
            lastWriteMs = now
            val root = JsonObject.builder()
                .put("track_id", trackId)
                .put("title", title)
                .put("artist", artist)
                .put("album", album)
                .put("cover_url", coverUrl)
                .put("position_ms", positionMs)
                .put("duration_ms", durationMs)
                .put("saved_at", now)
                .build()
                .toJsonString()
            val out = file(context)
            out.parentFile?.mkdirs()
            // Synchronous write: the process may die at any moment.
            val tmp = java.io.File(out.parent, "$FILE.tmp")
            tmp.writeText(root)
            if (!tmp.renameTo(out)) {
                out.writeText(root)
            }
        } catch (_: Exception) {
        }
    }

    fun load(context: Context): Pinned? {
        return try {
            val raw = file(context).takeIf { it.isFile }?.readText() ?: return null
            val o = parseJsonObject(raw)
            val trackId = o.optString("track_id", "").ifEmpty { return null }
            Pinned(
                trackId = trackId,
                title = o.optString("title", "Unknown"),
                artist = o.optString("artist", ""),
                album = o.optString("album", ""),
                coverUrl = o.optString("cover_url", "").ifEmpty { null },
                positionMs = o.optLong("position_ms") ?: 0L,
                durationMs = o.optLong("duration_ms") ?: 0L,
            )
        } catch (_: Exception) {
            null
        }
    }

    fun clear(context: Context) {
        try {
            file(context).delete()
        } catch (_: Exception) {
        }
        lastTrackId = null
        lastWriteMs = 0L
    }
}
