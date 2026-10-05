package com.soundsible.android

import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import org.json.JSONArray
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.SessionCommand
import java.security.MessageDigest
import okhttp3.HttpUrl.Companion.toHttpUrl

/** Stable occurrence identity crosses MediaSession IPC in metadata; never contains credentials. */
@UnstableApi
object ProgramQueue {
    const val PODCAST = "soundsible_podcast"
    const val ENCLOSURE = "soundsible_enclosure"
    const val EPISODE = "soundsible_episode"
    const val FEED = "soundsible_feed"
    const val PROFILE = "soundsible_profile"
    const val SOURCE = "soundsible_source"
    const val KEY = "soundsible_occurrence"
    const val PROGRAM = "soundsible_program"
    val command = SessionCommand("soundsible.queue.edit", Bundle.EMPTY)
    fun key(player: Player, index: Int): String = player.getMediaItemAt(index).mediaMetadata.extras?.getString(KEY) ?: ""
    fun programToken(player: Player): String = if (player.mediaItemCount == 0) "" else player.getMediaItemAt(0).mediaMetadata.extras?.getString(PROGRAM) ?: ""
    fun token(player: Player): String {
        val keys = (0 until player.mediaItemCount).joinToString("|") { key(player, it) }
        return MessageDigest.getInstance("SHA-256").digest(keys.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }
    const val LIMIT = 1000
    /** Metadata only crosses the bridge. Credentials and source addresses stay native. */
    fun items(connection: EngineConnection, rows: JSONArray, program: String = "", contextKind: String? = null, contextId: String? = null): List<MediaItem> {
        require(rows.length() in 1..LIMIT && rows.toString().toByteArray(Charsets.UTF_8).size <= 256 * 1024)
        require(contextKind == null || contextKind in listOf("album", "artist", "playlist"))
        require(contextId == null || (contextId.isNotBlank() && contextId.length <= 512))
        fun number(row: org.json.JSONObject, name: String) = row.optDouble(name, Double.NaN).takeIf { it.isFinite() }
        val reference = if (contextKind == "album" && !contextId.isNullOrEmpty()) ProgramLoudness.albumReference(
            (0 until rows.length()).map { i -> val row = rows.getJSONObject(i); ProgramLoudness.Facts(number(row, "loudness_lufs"), number(row, "loudness_peak_dbtp"), number(row, "duration")) }
        ) else null
        val owner = program.ifBlank { java.util.UUID.randomUUID().toString() }
        return (0 until rows.length()).map { i ->
            val row = rows.getJSONObject(i)
            val source = row.getString("source")
            require(source in listOf("local", "preview", "podcast"))
            val id = row.getString("id")
            if (source == "preview") require(Regex("^[A-Za-z0-9_-]{11}$").matches(id))
            val podcast = source == "podcast" || row.optString("mediaKind") == "podcast_episode"
            require(id.isNotBlank() && id.length <= if (podcast) 8192 else 512)
            val enclosure = if (podcast) row.optString("enclosure", "") else ""
            val episode = row.optString("episodeGuid", ""); val feed = row.optString("feedId", "")
            require(episode.length <= 8192 && feed.length <= 8192)
            if (podcast) {
                require(enclosure.isNotEmpty() || (source == "local" && episode.isNotEmpty() && feed.isNotEmpty()))
                if (enclosure.isNotEmpty()) {
                    val url = enclosure.toHttpUrl()
                    require(enclosure.length <= 8192 && url.encodedUsername.isEmpty() && url.encodedPassword.isEmpty())
                }
            }
            val title = row.optString("title"); val artist = row.optString("artist"); val album = row.optString("album")
            require(listOf(title, artist, album).all { it.length <= 4096 })
            val key = java.util.UUID.randomUUID().toString()
            val offline = source == "local" && connection.offline.canUse(connection.generation) && connection.offline.local(id,connection.generation) != null
            require(connection.cookieHeader(connection.generation) != null || offline)
            val path = if (source == "preview") "/api/preview/stream/" else if (source == "podcast") "/api/android-podcast/" else "/api/static/stream/"
            MediaItem.Builder().setMediaId(id)
                .setUri(connection.origin + path + android.net.Uri.encode(id) + "?android_generation=" + connection.generation + "&android_occurrence=" + key)
                .setMediaMetadata(MediaMetadata.Builder().setTitle(title).setArtist(artist).setAlbumTitle(album).setArtworkUri(if (source == "local" && !offline) ProgramArtwork.uri(connection.generation, id) else null)
                    .setExtras(Bundle().apply {
                        putLong(ProgramPcmProcessor.GENERATION, connection.generation)
                        number(row, "loudness_lufs")?.let { putDouble(ProgramPcmProcessor.LUFS, it) }
                        number(row, "loudness_peak_dbtp")?.let { putDouble(ProgramPcmProcessor.PEAK, it) }
                        number(row, "duration")?.let { putDouble(ProgramPcmProcessor.DURATION, it) }
                        if (contextKind != null && contextId != null) {
                            putString(ProgramPcmProcessor.CONTEXT_KIND, contextKind); putString(ProgramPcmProcessor.CONTEXT_ID, contextId)
                            reference?.let { putDouble(ProgramPcmProcessor.ALBUM_LUFS, it.lufs); putDouble(ProgramPcmProcessor.ALBUM_PEAK, it.peakDbtp) }
                        }
                        putBoolean(PODCAST, podcast); if (podcast) { putString(ENCLOSURE, enclosure); putString(EPISODE, episode); putString(FEED, feed); putString(PROFILE, connection.offline.profileKey(connection.generation)) }; putString(KEY, key); putString(PROGRAM, owner); putString(SOURCE, source); putBoolean("offline", offline) }).build()).build()
        }
    }
    /** Called on the service's player looper: validate actual queue, then mutate it once. */
    fun edit(player: Player, connection: EngineConnection, args: Bundle, beforeRetry: () -> Unit = {}, resume: (MediaItem) -> Long = { 0 }, manualInsertion: Int? = null) {
        require(args.getLong("generation", -1) == connection.generation && (connection.cookieHeader(connection.generation) != null || connection.offline.canUse(connection.generation)))
        require(args.getString("queueToken") == token(player))
        val action = args.getString("action")
        if (action == "append" || action == "insertAfter") {
            val empty = player.mediaItemCount == 0
            val insertion = if (action == "append") (manualInsertion ?: player.mediaItemCount).also { require(it in 0..player.mediaItemCount) } else {
                val anchor = args.getInt("index", -1)
                if (empty) { require(anchor == -1 && args.getString("key") == ""); 0 }
                else {
                    require(anchor == player.currentMediaItemIndex && anchor in 0 until player.mediaItemCount)
                    require(args.getString("key") == key(player, anchor) && key(player, anchor).isNotBlank())
                    anchor + 1
                }
            }
            val rows = JSONArray(args.getString("tracks") ?: error("NO_TRACKS"))
            require(rows.length() in 1..(LIMIT - player.mediaItemCount))
            val additions = items(connection, rows, programToken(player)) // Validate the entire payload before changing the player.
            if (empty) player.pause() // stop/clear can leave playWhenReady set; adding must never autoplay.
            player.addMediaItems(insertion, additions)
            if (empty) player.prepare()
            return
        }
        val index = args.getInt("index", -1)
        require(index in 0 until player.mediaItemCount && args.getString("key") == key(player, index) && key(player, index).isNotBlank())
        when (args.getString("action")) {
            "skip" -> {
                require(index == player.currentMediaItemIndex && player.currentMediaItem?.mediaMetadata?.extras?.getBoolean(PODCAST) == true && player.isCurrentMediaItemSeekable)
                val seconds = args.getInt("seconds", 0); require(seconds == -15 || seconds == 15)
                player.seekTo(PodcastPosition.skip(player.currentPosition, player.duration, seconds))
            }
            "play" -> {
                require(index == player.currentMediaItemIndex)
                if (player.playerError != null || player.playbackState == Player.STATE_ENDED) beforeRetry()
                if (player.playerError != null || player.playbackState == Player.STATE_ENDED) {
                    if (player.playbackState == Player.STATE_ENDED) player.seekTo(index, 0)
                    player.prepare()
                }
                player.play()
            }
            "retry" -> {
                require(index == player.currentMediaItemIndex && PlaybackRecovery.kind(player.playerError) in listOf("connection", "server"))
                beforeRetry()
                player.prepare() // Retry at the retained position and keep the latest playWhenReady intention.
            }
            "select" -> { if (index == player.currentMediaItemIndex && (player.playerError != null || player.playbackState == Player.STATE_ENDED)) beforeRetry(); player.seekTo(index, resume(player.getMediaItemAt(index))); if (player.playerError != null || player.playbackState == Player.STATE_ENDED) player.prepare(); player.play() }
            "move" -> { val target = args.getInt("toIndex", -1); require(target in 0 until player.mediaItemCount); player.moveMediaItem(index, target) }
            "remove" -> { if (player.mediaItemCount == 1) { player.stop(); player.clearMediaItems() } else player.removeMediaItem(index) }
            else -> error("INVALID_EDIT")
        }
    }
}
