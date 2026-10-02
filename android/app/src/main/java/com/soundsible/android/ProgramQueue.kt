package com.soundsible.android

import android.os.Bundle
import androidx.media3.common.Player
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
    /** Called on the service's player looper: validate actual queue, then mutate it once. */
    fun edit(player: Player, connection: EngineConnection, args: Bundle) {
        require(args.getLong("generation", -1) == connection.generation && connection.cookieHeader(connection.generation) != null)
        require(args.getString("queueToken") == token(player))
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
