package com.soundsible.android

import android.net.Uri
import android.os.Handler
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.LibraryResult
import androidx.media3.session.SessionError
import androidx.media3.session.MediaLibraryService.LibraryParams
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import org.json.JSONObject
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Scoped Core tree; head units never supply stream addresses or credentials. */
@UnstableApi
internal class ProgramCarLibrary(private val connection: EngineConnection, private val main: Handler, private val offlineTitle: String) : AutoCloseable {
    companion object { const val ROOT = "soundsible:car"; const val OFFLINE = "soundsible:offline"; private const val SEARCH = "soundsible:search:" }
    private val worker = ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, ArrayBlockingQueue<Runnable>(16))
    private val rows = linkedMapOf<String, JSONObject>()
    private val counts = linkedMapOf<String, Int>()
    private val requests = mutableSetOf<String>()
    private val pending = mutableMapOf<String, () -> Unit>()
    private var generation = -1L
    private var cacheIdentity: String? = null
    @Volatile private var closed = false
    fun root(params: LibraryParams?): ListenableFuture<LibraryResult<MediaItem>> {
        val epoch = connection.generation
        if (connection.sessionIdentity(epoch) == null) return Futures.immediateFuture(LibraryResult.ofError(SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED))
        return Futures.immediateFuture(LibraryResult.ofItem(MediaItem.Builder().setMediaId(ROOT).setMediaMetadata(
            MediaMetadata.Builder().setTitle("Soundsible").setIsBrowsable(true).setIsPlayable(false).build()).build(), params))
    }
    fun children(parent: String, page: Int, size: Int, params: LibraryParams?): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
        val future = SettableFuture.create<LibraryResult<ImmutableList<MediaItem>>>()
        // Media3's legacy bridge uses this sentinel for unpaginated browse.
        // Bound the response to the store's maximum, never allocate by caller size.
        val unpaginated = page == 0 && size == Int.MAX_VALUE
        val pageSize = if (unpaginated) 1000 else size
        if (closed || parent.length > 1024 || page < 0 || (!unpaginated && size !in 1..200)) {
            future.set(LibraryResult.ofError(SessionError.ERROR_BAD_VALUE)); return future
        }
        val epoch = connection.generation
        val identity = connection.sessionIdentity(epoch)
        if (identity == null) { future.set(LibraryResult.ofError(SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED)); return future }
        if (generation != epoch || cacheIdentity != identity) { rows.clear(); counts.clear(); generation = epoch; cacheIdentity = identity }
        val id = "car-browse:" + java.util.UUID.randomUUID()
        requests.add(id)
        pending[id] = { future.set(LibraryResult.ofError(SessionError.ERROR_SESSION_DISCONNECTED)) }
        try {
            worker.execute {
                var answer: JSONObject? = null; var code = 0
                var copies = org.json.JSONArray()
                try {
                    // Initial integrity checks can hash large files; keep them
                    // off the service/player looper.
                    if (parent == ROOT || parent == OFFLINE) copies = offlineRows(epoch)
                    if (parent == OFFLINE) {
                        code = 200; answer = JSONObject().put("items", copies)
                    } else {
                    val path = when {
                        parent == ROOT -> "/api/car/home"
                        parent.startsWith(SEARCH) -> "/api/car/search?q=" + Uri.encode(parent.removePrefix(SEARCH))
                        else -> "/api/car/items/" + Uri.encode(parent)
                    }
                    connection.execute(path, "GET", null, emptyMap(), epoch, id, 10000).use {
                        code = it.code
                        if (it.isSuccessful) {
                            val raw = it.peekBody(262145).string(); require(raw.toByteArray().size <= 262144)
                            answer = JSONObject(raw)
                        }
                    }
                    }
                } catch (_: Exception) { }
                main.post {
                    requests.remove(id); pending.remove(id)
                    if (closed || epoch != connection.generation || runCatching { connection.sessionIdentity(epoch) }.getOrNull() != identity) {
                        future.set(LibraryResult.ofError(SessionError.ERROR_SESSION_DISCONNECTED)); return@post
                    }
                    if (code == 401 || code == 403) {
                        future.set(LibraryResult.ofError(if (code == 401) SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED else SessionError.ERROR_PERMISSION_DENIED))
                        // Observed revocation invalidates explicit copies and the
                        // active programme; a permission403 never switches account.
                        if (code == 401) connection.clearSession(false)
                        return@post
                    }
                    try {
                        val items = answer?.getJSONArray("items") ?: if (parent == ROOT && code !in listOf(401, 403) && copies.length() > 0) org.json.JSONArray() else throw IllegalArgumentException()
                        require(items.length() <= if (parent == OFFLINE) 1000 else 200)
                        if (parent == ROOT && copies.length() > 0) items.put(JSONObject().put("id", OFFLINE).put("title", offlineTitle).put("is_browsable", true).put("is_playable", false))
                        complete(parent, items, page, pageSize, params, future)
                    } catch (_: Exception) { future.set(LibraryResult.ofError(if (code == 404) SessionError.ERROR_BAD_VALUE else SessionError.ERROR_IO)) }
                }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            requests.remove(id); pending.remove(id); future.set(LibraryResult.ofError(SessionError.ERROR_IO))
        }
        future.addListener({ if (future.isCancelled) connection.cancel(id) }, { it.run() })
        return future
    }
    private fun offlineRows(epoch: Long): org.json.JSONArray {
        val state = connection.offline.state(epoch)
        val result = org.json.JSONArray()
        val items = state.getJSONArray("items")
        for (index in 0 until items.length()) {
            val copy = items.getJSONObject(index)
            if (copy.optString("state") != "ready") continue
            val track = copy.getJSONObject("track")
            result.put(JSONObject().put("id", track.getString("id")).put("track_id", track.getString("id"))
                .put("kind", "track").put("title", track.optString("title")).put("artist", track.optString("artist"))
                .put("album", track.optString("album")).put("duration_sec", track.optDouble("duration", 0.0))
                .put("is_browsable", false).put("is_playable", true))
        }
        return result
    }
    private fun complete(parent: String, items: org.json.JSONArray, page: Int, size: Int, params: LibraryParams?, future: SettableFuture<LibraryResult<ImmutableList<MediaItem>>>) {
        require(items.length() <= 1000)
        counts.remove(parent); counts[parent] = items.length()
        while (counts.size > 500) counts.remove(counts.keys.first())
        val offset = (page.toLong() * size).coerceAtMost(items.length().toLong()).toInt()
        val parsed = (offset until minOf(offset + size, items.length())).map { index ->
            val row = items.getJSONObject(index)
            val key = row.getString("id"); require(key.isNotBlank() && key.length <= 1024)
            for (field in listOf("title", "subtitle", "artist", "album")) require(row.optString(field).length <= 4096)
            val media = mediaItem(row)
            rows.remove(media.mediaId); rows[media.mediaId] = JSONObject(row.toString())
            while (rows.size > 1000) rows.remove(rows.keys.first())
            media
        }
        future.set(LibraryResult.ofItemList(parsed, params))
    }
    private fun mediaItem(row: JSONObject): MediaItem {
        val id = row.getString("id")
        val playable = row.optBoolean("is_playable")
        val key = if (!playable) id else (if (row.optString("kind") == "radio_seed") "soundsible:radio:" else "soundsible:track:") + Uri.encode(id)
        return MediaItem.Builder().setMediaId(key).setMediaMetadata(MediaMetadata.Builder()
            .setTitle(row.optString("title")).setSubtitle(row.optString("subtitle"))
            .setArtist(row.optString("artist")).setAlbumTitle(row.optString("album"))
            .setIsBrowsable(row.optBoolean("is_browsable")).setIsPlayable(playable).build()).build()
    }
    private fun currentCache(): Boolean = !closed && generation == connection.generation && cacheIdentity != null &&
        runCatching { connection.sessionIdentity(generation) }.getOrNull() == cacheIdentity
    fun decorate(item: MediaItem, recipient: String, artwork: ProgramCarArtwork): MediaItem {
        val row = rows[item.mediaId] ?: return item
        if (!currentCache() || !row.optBoolean("is_playable")) return item
        val id = row.optString("track_id")
        if (id.isBlank()) return item
        return item.buildUpon().setMediaMetadata(item.mediaMetadata.buildUpon().setArtworkUri(artwork.publish(id, recipient)).build()).build()
    }
    fun childCount(parent: String): Int = if (currentCache()) counts[parent] ?: 0 else 0
    fun search(query: String, page: Int, size: Int, params: LibraryParams?): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
        val text = query.trim()
        if (text.isEmpty() || text.length > 256) return Futures.immediateFuture(LibraryResult.ofError(SessionError.ERROR_BAD_VALUE))
        return children(SEARCH + text, page, size, params)
    }
    fun searchCount(query: String): Int = childCount(SEARCH + query.trim())
    fun item(id: String): ListenableFuture<LibraryResult<MediaItem>> {
        if (!currentCache()) return Futures.immediateFuture(LibraryResult.ofError(SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED))
        val row = rows[id] ?: return Futures.immediateFuture(LibraryResult.ofError(SessionError.ERROR_BAD_VALUE))
        return Futures.immediateFuture(LibraryResult.ofItem(mediaItem(row), null))
    }
    data class Selection(val items: List<MediaItem>, val generation: Long, val identity: String, val radio: Boolean)
    /** Resolve IDs returned by this authenticated tree; ignore caller metadata and URI. */
    fun select(requested: List<MediaItem>): Selection {
        require(currentCache() && requested.size in 1..32)
        val selected = requested.map { rows[it.mediaId] ?: error("Unknown car item") }
        require(selected.all { it.optBoolean("is_playable") && it.optString("track_id").isNotBlank() })
        val radio = selected.any { it.optString("kind") == "radio_seed" }
        require(!radio || selected.size == 1 && selected.all {
            it.isNull("podcast_episode_guid") || it.optString("podcast_episode_guid", "").isBlank()
        })
        val decoded = org.json.JSONArray()
        selected.forEach { row ->
            decoded.put(JSONObject().put("source", "local").put("id", row.getString("track_id"))
                .put("title", row.optString("title")).put("artist", row.optString("artist"))
                .put("album", row.optString("album")).put("duration", row.optDouble("duration_sec", 0.0)).apply {
                    if (row.optString("kind") == "podcast_episode") {
                        put("mediaKind", "podcast_episode")
                        put("feedId", row.optString("podcast_feed_id", ""))
                        put("episodeGuid", row.optString("podcast_episode_guid", ""))
                    }
                })
        }
        return Selection(ProgramQueue.items(connection, decoded), generation, cacheIdentity!!, radio)
    }
    fun reset() {
        requests.forEach(connection::cancel); requests.clear()
        pending.values.toList().forEach { it() }; pending.clear()
        rows.clear(); counts.clear(); generation = -1; cacheIdentity = null; worker.queue.clear()
    }
    // Proactive subscription updates and external host acceptance remain pending.
    override fun close() { closed = true; reset(); worker.shutdownNow() }
}
