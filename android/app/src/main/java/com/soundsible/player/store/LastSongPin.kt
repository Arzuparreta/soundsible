package com.soundsible.player.store

import android.content.Context
import com.soundsible.player.data.CarItem
import com.soundsible.player.data.JsonObject
import com.soundsible.player.data.parseJsonObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Pinned copy of the last played song: bytes plus metadata, outside every
 * eviction policy, surviving updates (app-private storage is preserved).
 * Resume-after-anything plays this file when the queue snapshot points at
 * it, with zero network.
 */
object LastSongPin {
    private const val DIR = "last-song"
    private const val AUDIO = "audio.bin"
    private const val META = "meta.json"

    data class Pinned(
        val trackId: String,
        val title: String,
        val artist: String,
        val album: String,
        val artworkUrl: String?,
        val file: File,
    ) {
        fun toItem(): CarItem = CarItem(
            id = trackId,
            kind = "track",
            trackId = trackId,
            title = title,
            artist = artist,
            album = album,
            artworkUrl = artworkUrl,
            streamUrl = file.toURI().toString(),
            isPlayable = true,
        )
    }

    private fun dir(context: Context): File = File(context.filesDir, "soundsible/$DIR")

    fun pinnedTrackId(context: Context): String? {
        return try {
            val meta = File(dir(context), META).takeIf { it.isFile } ?: return null
            parseJsonObject(meta.readText()).optString("track_id", "").ifEmpty { null }
        } catch (_: Exception) {
            null
        }
    }

    fun load(context: Context): Pinned? {
        return try {
            val root = dir(context)
            val audio = File(root, AUDIO).takeIf { it.isFile } ?: return null
            val meta = parseJsonObject(File(root, META).readText())
            val trackId = meta.optString("track_id", "").ifEmpty { return null }
            Pinned(
                trackId = trackId,
                title = meta.optString("title", "Unknown"),
                artist = meta.optString("artist", ""),
                album = meta.optString("album", ""),
                artworkUrl = meta.optString("artwork_url", "").ifEmpty { null },
                file = audio,
            )
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Pin [streamUrl] bytes with [meta]. Skips when this track is already
     * pinned. Blocking network I/O: call off the main thread. Never throws.
     */
    fun maybePin(
        context: Context,
        trackId: String,
        title: String,
        artist: String,
        album: String,
        artworkUrl: String?,
        streamUrl: String,
        token: String?,
    ) {
        try {
            val root = dir(context)
            if (pinnedTrackId(context) == trackId && File(root, AUDIO).isFile) return
            root.mkdirs()
            val conn = (URL(streamUrl).openConnection() as HttpURLConnection).apply {
                if (token != null) setRequestProperty("Authorization", "Bearer $token")
                connectTimeout = 15_000
                readTimeout = 60_000
            }
            try {
                if (conn.responseCode !in 200..299) return
                val tmp = File(root, "$AUDIO.tmp")
                conn.inputStream.use { input ->
                    tmp.outputStream().use { output -> input.copyTo(output) }
                }
                if (!tmp.renameTo(File(root, AUDIO))) return
            } finally {
                conn.disconnect()
            }
            File(root, META).writeText(
                JsonObject.builder()
                    .put("track_id", trackId)
                    .put("title", title)
                    .put("artist", artist)
                    .put("album", album)
                    .put("artwork_url", artworkUrl)
                    .build()
                    .toJsonString(),
            )
        } catch (_: Exception) {
        }
    }

    fun clear(context: Context) {
        try {
            dir(context).deleteRecursively()
        } catch (_: Exception) {
        }
    }
}
