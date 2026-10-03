package com.soundsible.android

import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import org.json.JSONArray
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.SessionCommand
import java.security.MessageDigest

/** Stable occurrence identity crosses MediaSession IPC in metadata; never contains credentials. */
@UnstableApi
object ProgramQueue {
    const val KEY = "soundsible_occurrence"
    val command = SessionCommand("soundsible.queue.edit", Bundle.EMPTY)
    fun key(player: Player, index: Int): String = player.getMediaItemAt(index).mediaMetadata.extras?.getString(KEY) ?: ""
    fun token(player: Player): String {
        val keys = (0 until player.mediaItemCount).joinToString("|") { key(player, it) }
        return MessageDigest.getInstance("SHA-256").digest(keys.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }
    const val LIMIT = 1000
    /** Metadata only crosses the bridge. Credentials and source addresses stay native. */
    fun items(connection: EngineConnection, rows: JSONArray): List<MediaItem> {
        require(rows.length() in 1..LIMIT)
        return (0 until rows.length()).map { i ->
            val row = rows.getJSONObject(i)
            val id = row.getString("id")
            require(id.isNotBlank() && id.length <= 512)
            val title = row.optString("title"); val artist = row.optString("artist"); val album = row.optString("album")
            require(listOf(title, artist, album).all { it.length <= 4096 })
            MediaItem.Builder().setMediaId(id)
                .setUri(connection.origin + "/api/static/stream/" + android.net.Uri.encode(id) + "?android_generation=" + connection.generation)
                .setMediaMetadata(MediaMetadata.Builder().setTitle(title).setArtist(artist).setAlbumTitle(album)
                    .setExtras(Bundle().apply { putString(KEY, java.util.UUID.randomUUID().toString()) }).build()).build()
        }
    }
    /** Called on the service's player looper: validate actual queue, then mutate it once. */
    fun edit(player: Player, connection: EngineConnection, args: Bundle) {
        require(args.getLong("generation", -1) == connection.generation && connection.cookieHeader(connection.generation) != null)
        require(args.getString("queueToken") == token(player))
        val action = args.getString("action")
        if (action == "append" || action == "insertAfter") {
            val empty = player.mediaItemCount == 0
            val insertion = if (action == "append") player.mediaItemCount else {
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
            val additions = items(connection, rows) // Validate the entire payload before changing the player.
            if (empty) player.pause() // stop/clear can leave playWhenReady set; adding must never autoplay.
            player.addMediaItems(insertion, additions)
            if (empty) player.prepare()
            return
        }
        val index = args.getInt("index", -1)
        require(index in 0 until player.mediaItemCount && args.getString("key") == key(player, index) && key(player, index).isNotBlank())
        when (args.getString("action")) {
            "select" -> { player.seekTo(index, 0); if (player.playerError != null || player.playbackState == Player.STATE_ENDED) player.prepare(); player.play() }
            "move" -> { val target = args.getInt("toIndex", -1); require(target in 0 until player.mediaItemCount); player.moveMediaItem(index, target) }
            "remove" -> { if (player.mediaItemCount == 1) { player.stop(); player.clearMediaItems() } else player.removeMediaItem(index) }
            else -> error("INVALID_EDIT")
        }
    }
}
