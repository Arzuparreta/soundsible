package com.soundsible.android

import android.os.Bundle
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import org.json.JSONArray

/** Confirmed library labels update compatible media items, preserving every source and occurrence. */
@UnstableApi
object ProgramMetadata {
    fun apply(player: Player, connection: EngineConnection, args: Bundle, invalidate: () -> Unit = {}) {
        require(args.getLong("generation", -1) == connection.generation)
        val rows = JSONArray(args.getString("tracks") ?: error("NO_METADATA"))
        require(rows.length() in 1..ProgramQueue.LIMIT && rows.toString().toByteArray().size <= 256 * 1024)
        val updates = (0 until rows.length()).map { rows.getJSONObject(it) }
        require(updates.map { it.getString("id") }.distinct().size == updates.size)
        updates.forEach { row ->
            require(row.getString("id").isNotBlank() && row.getString("id").length <= 512)
            require(listOf("title", "artist", "album").all { row.getString(it).length <= 4096 })
            require(listOf("album_artist", "album_id", "artist_id").all { !row.has(it) || row.isNull(it) || (row.get(it) is String && row.getString(it).length <= 4096) })
        }
        val byId = updates.associateBy { it.getString("id") }
        val revision = args.getString("metadataRevision") ?: error("NO_REVISION")
        require(Regex("^[a-f0-9-]{36}$").matches(revision))
        connection.offline.updateMetadata(connection.generation, rows)
        invalidate()
        for (index in 0 until player.mediaItemCount) {
            val item = player.getMediaItemAt(index)
            if (item.mediaMetadata.extras?.getString(ProgramQueue.SOURCE) != "local") continue
            val row = byId[item.mediaId] ?: continue
            val metadata = item.mediaMetadata.buildUpon().setTitle(row.getString("title")).setArtist(row.getString("artist"))
                .setAlbumTitle(row.getString("album")).apply { if (row.has("album_artist")) setAlbumArtist(if (row.isNull("album_artist")) null else row.getString("album_artist")) }.setExtras(Bundle(item.mediaMetadata.extras).apply { putString("metadataRevision", revision) })
                .setArtworkUri(if (item.mediaMetadata.extras?.getBoolean("offline") == true) null else ProgramArtwork.uri(connection.generation, item.mediaId, revision)).build()
            player.replaceMediaItem(index, item.buildUpon().setMediaMetadata(metadata).build())
        }
    }
}
