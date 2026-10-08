package com.soundsible.android

import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import org.json.JSONArray
import org.json.JSONObject

/** Shared playbackSession v1 wire format. Native source URLs/cookies never travel. */
@UnstableApi
internal object ProgramDeviceState {
    private const val DEVICE_LANE = ProgramQueue.LANE
    private const val DEVICE_SOURCE = ProgramQueue.LANE_SOURCE
    private const val DEVICE_CONTEXT = "soundsible_device_context"
    private const val DEVICE_CONTEXT_INDEX = "soundsible_device_context_index"
    private const val DEVICE_PLAN = "soundsible_device_plan"
    private const val DEVICE_ROUTE = ProgramQueue.ROUTE
    private const val DEVICE_YOUTUBE = "soundsible_device_youtube"
    data class Restored(val rows: JSONArray, val index: Int, val positionMs: Long, val shuffle: Boolean, val repeat: Int, val workspace: JSONObject? = null, val entries: JSONArray? = null, val radio: JSONObject? = null)
    fun track(item: MediaItem): JSONObject {
        val extras = item.mediaMetadata.extras
        val source = extras?.getString(ProgramQueue.SOURCE)
        val id = item.mediaId.let { if (it.startsWith("soundsible:track:")) android.net.Uri.decode(it.removePrefix("soundsible:track:")) else it }
        return JSONObject().put("id", id).put("title", item.mediaMetadata.title?.toString().orEmpty())
            .put("artist", item.mediaMetadata.artist?.toString().orEmpty()).put("album", item.mediaMetadata.albumTitle?.toString().orEmpty())
            .put("duration", extras?.getDouble(ProgramPcmProcessor.DURATION, 0.0) ?: 0.0).apply {
                // The record and the place on it travel with the queue, so the
                // device it lands on can still file a download correctly.
                ProgramRelease.of(item.mediaMetadata).writeTo(this)
                extras?.getString(ProgramQueue.PENDING)?.let { put("pendingResolve", JSONObject(it)) }
                if (source == "preview" || source == "podcast") put("source", "preview")
                if (source == "preview") put("youtube_id", id)
                extras?.getString(DEVICE_YOUTUBE)?.takeIf { Regex("^[A-Za-z0-9_-]{11}$").matches(it) }?.let { put("youtube_id", it) }
                extras?.let { facts ->
                    if (facts.containsKey(ProgramPcmProcessor.LUFS)) put("loudness_lufs", facts.getDouble(ProgramPcmProcessor.LUFS))
                    if (facts.containsKey(ProgramPcmProcessor.PEAK)) put("loudness_peak_dbtp", facts.getDouble(ProgramPcmProcessor.PEAK))
                }
                if (extras?.getBoolean(ProgramQueue.PODCAST) == true) {
                    put("media_kind", "podcast_episode"); put("podcast_enclosure_url", extras.getString(ProgramQueue.ENCLOSURE))
                    put("podcast_episode_guid", extras.getString(ProgramQueue.EPISODE)); put("podcast_feed_id", extras.getString(ProgramQueue.FEED))
                }
            }
    }
    fun snapshot(player: Player, radio: RadioProgram? = null): JSONObject? {
        if (player.mediaItemCount == 0 || player.currentMediaItem?.mediaMetadata?.extras?.getString(ProgramQueue.SOURCE) == "live") return null
        val index = player.currentMediaItemIndex.coerceIn(0, player.mediaItemCount - 1)
        val start = (index - 5).coerceAtLeast(0)
        val queue = JSONArray()
        for (i in start until minOf(player.mediaItemCount, index + 41)) {
            val item = player.getMediaItemAt(i)
            val key = ProgramQueue.key(player, i); val extras = item.mediaMetadata.extras
            val generated = key in (radio?.generatedKeys() ?: emptySet())
            val automatic = extras?.getBoolean("autoplayGenerated") == true
            queue.put(track(item).put("queueId", key).put("queueLane", if (generated || automatic) "generated" else extras?.getString(DEVICE_LANE) ?: "manual")
                .put("queueSource", if (generated) "radio" else if (automatic) "autoplay" else extras?.getString(DEVICE_SOURCE) ?: "library").apply {
                    extras?.getString(DEVICE_CONTEXT)?.let { put("queueContext", JSONObject(it)) }
                    if (extras?.containsKey(DEVICE_CONTEXT_INDEX) == true) put("queueContextIndex", extras.getInt(DEVICE_CONTEXT_INDEX))
                })
        }
        val session = JSONObject().put("v", 1).put("mode", "now_playing").put("queue", queue).put("index", index - start)
            .put("shuffle", player.shuffleModeEnabled).put("repeat", when (player.repeatMode) { Player.REPEAT_MODE_ALL -> "all"; Player.REPEAT_MODE_ONE -> "one"; else -> "off" })
            .put("radio", (radio?.snapshot() ?: JSONObject().put("active", false).put("seedId", JSONObject.NULL))).put("auto", JSONObject.NULL)
        return JSONObject().put("track_id", track(player.getMediaItemAt(index)).getString("id")).put("track", track(player.getMediaItemAt(index)))
            .put("position_sec", player.currentPosition.coerceAtLeast(0) / 1000.0).put("is_playing", player.isPlaying).put("session", session)
    }
    fun items(connection: EngineConnection, restored: Restored): List<MediaItem> = ProgramQueue.items(connection, restored.rows).mapIndexed { i, item ->
        val entry = restored.entries?.optJSONObject(i) ?: return@mapIndexed item
        item.buildUpon().setMediaMetadata(item.mediaMetadata.buildUpon().setExtras(android.os.Bundle(item.mediaMetadata.extras).apply {
            val lane = entry.optString("queueLane", "manual"); val source = entry.optString("queueSource", "library")
            require(lane in listOf("manual", "context", "generated") && source.length <= 64)
            putString(DEVICE_LANE, lane); putString(DEVICE_SOURCE, source)
            if (source == "autoplay" && lane == "generated") putBoolean("autoplayGenerated", true)
            entry.optJSONObject("queueContext")?.let { require(it.toString().length <= 16384); putString(DEVICE_CONTEXT, it.toString()) }
            if (entry.has("queueContextIndex")) putInt(DEVICE_CONTEXT_INDEX, entry.optInt("queueContextIndex", 0).coerceIn(0, 1000000))
            entry.optString("youtube_id").takeIf { Regex("^[A-Za-z0-9_-]{11}$").matches(it) }?.let { putString(DEVICE_YOUTUBE, it) }
        }).build()).build()
    }
    fun snapshotDj(player: Player, dj: ProgramDjSession, planner: ProgramDjPlanner): JSONObject? {
        val body = snapshot(player) ?: return null
        val session = body.getJSONObject("session"); val queue = session.getJSONArray("queue")
        val route = dj.routeSnapshot().rows.associateBy { it.item.mediaMetadata.extras?.getString(ProgramQueue.KEY) }
        val plan = JSONObject()
        for (i in 0 until queue.length()) {
            val entry = queue.getJSONObject(i); val key = entry.getString("queueId"); val native = route[key] ?: continue
            entry.put("queueSource", "auto_mode").put("queueLane", if (native.kind == "user") "manual" else "generated")
            entry.put("autoRoute", (native.item.mediaMetadata.extras?.getString(DEVICE_ROUTE)?.let(::JSONObject)?.put("kind", native.kind) ?: JSONObject().put("kind", native.kind)).put("placement", if (native.kind == "user") "fixed" else "dj").apply {
                native.ownerKey?.let { put("ownerQueueId", it) }
            })
            native.proposal?.let { proposal ->
                val transition = JSONObject().put("technique", proposal.technique.name.lowercase(java.util.Locale.ROOT))
                    .put("out_cue", if (proposal.outCue.isFinite()) proposal.outCue else JSONObject.NULL)
                    .put("in_cue", proposal.inCue.takeIf { it.isFinite() } ?: 0.0).put("overlap_seconds", proposal.overlap.takeIf { it.isFinite() } ?: 6.0)
                    .put("playback_rate", proposal.rate.takeIf { it.isFinite() } ?: 1.0).put("confidence", proposal.confidence.takeIf { it.isFinite() } ?: 0.0)
                    .put("overlap_bars", 0).put("score", 0).put("fallback", proposal.confidence < 0.35)
                    .put("sync", JSONObject().put("out_period", 0).put("in_period", 0).put("phase_tolerance_ms", proposal.phaseToleranceMs.takeIf { it.isFinite() } ?: 5.0).put("grid_source", "estimated"))
                val previous = route[proposal.fromKey]?.item?.let(::track)
                if (previous != null) {
                    val inherited = native.item.mediaMetadata.extras?.getString(DEVICE_PLAN)?.let(::JSONObject) ?: JSONObject()
                        .put("source", if (entry.optString("source") == "preview") "related" else "local").put("reasonKey", "autoMode.reason.library")
                    plan.put(key, inherited.put("trackId", entry.optString("youtube_id").ifBlank { entry.getString("id") })
                        .put("fromKey", previous.optString("youtube_id").ifBlank { previous.getString("id") }).put("transition", transition))
                }
            }
        }
        val workspace = planner.workspace().put("heard", JSONArray().apply { dj.heardIds().toList().takeLast(15).forEach { put(JSONObject().put("id", it)) } })
            .put("plan", plan).put("staleSeams", JSONArray())
        session.put("mode", "auto").put("auto", workspace)
        return body
    }
    fun djRows(connection: EngineConnection, restored: Restored, planner: ProgramDjPlanner): List<ProgramDjSession.Row> {
        val entries = restored.entries ?: error("REMOTE_DJ_QUEUE_MISSING")
        require((0 until restored.rows.length()).none { restored.rows.getJSONObject(it).optString("source") == "pending" }) { "REMOTE_DJ_CATALOG_UNRESOLVED" }
        val items = ProgramQueue.items(connection, restored.rows)
        val keys = items.indices.associate { i -> entries.getJSONObject(i).getString("queueId") to items[i].mediaMetadata.extras!!.getString(ProgramQueue.KEY)!! }
        val plan = restored.workspace?.optJSONObject("plan") ?: JSONObject()
        return items.indices.map { i ->
            val entry = entries.getJSONObject(i); val route = entry.optJSONObject("autoRoute")
            val kind = route?.optString("kind", "generated") ?: "generated"
            require(kind in listOf("user", "generated", "bridge"))
            val owner = route?.optString("ownerQueueId")?.takeIf { it.isNotBlank() }
            val planned = plan.optJSONObject(entry.getString("queueId"))
            val item = items[i].buildUpon().setMediaMetadata(items[i].mediaMetadata.buildUpon().setExtras(android.os.Bundle(items[i].mediaMetadata.extras).apply {
                planned?.let { putString(DEVICE_PLAN, it.toString()) }
                route?.let { putString(DEVICE_ROUTE, it.toString()) }
                entry.optString("youtube_id").takeIf { Regex("^[A-Za-z0-9_-]{11}$").matches(it) }?.let { putString(DEVICE_YOUTUBE, it) }
                if (kind == "bridge") { require(owner != null && keys.containsKey(owner)); putString(ProgramQueue.BRIDGE_OWNER, keys[owner]) }
            }).build()).build()
            val previousEntry = entries.optJSONObject(i - 1)
            val from = planned?.optString("fromKey")
            val previousIdentity = previousEntry?.optString("youtube_id")?.ifBlank { previousEntry.optString("id") }
            val previousKey = items.getOrNull(i - 1)?.mediaMetadata?.extras?.getString(ProgramQueue.KEY)
            ProgramDjSession.Row(item, if (planned != null && from == previousIdentity && previousKey != null) planner.proposal(planned, previousKey) else null, kind)
        }
    }
    private fun row(track: JSONObject): JSONObject {
        val pending = track.optJSONObject("pendingResolve")
        val podcast = track.optString("media_kind") == "podcast_episode"
        val source = if (pending != null) "pending" else if (track.optString("source") == "preview") { if (podcast) "podcast" else "preview" } else "local"
        return JSONObject().put("source", source).put("id", track.getString("id")).put("title", track.optString("title"))
            .put("artist", track.optString("artist")).put("album", track.optString("album")).put("duration", track.optDouble("duration", 0.0)).apply {
                ProgramRelease.read(track).writeTo(this)
                if (pending != null) put("pendingResolve", JSONObject(pending.toString()))
                for (name in listOf("loudness_lufs", "loudness_peak_dbtp")) track.optDouble(name, Double.NaN).takeIf { it.isFinite() }?.let { put(name, it) }
                if (podcast) { put("mediaKind", "podcast_episode"); put("enclosure", track.optString("podcast_enclosure_url"))
                    put("episodeGuid", track.optString("podcast_episode_guid")); put("feedId", track.optString("podcast_feed_id")) }
            }
    }
    fun restore(payload: JSONObject): Restored? {
        val state = payload.optJSONObject("state") ?: JSONObject()
        val session = state.optJSONObject("session")
        val radio = session?.optJSONObject("radio")
        if (radio?.optBoolean("active") == true) {
            require(radio.optString("seedId").isNotBlank() && radio.optString("seedId").length <= 512)
            require(radio.optString("profile", "balanced") in listOf("familiar", "balanced", "explore"))
        }
        val workspace = if (session?.optString("mode") == "auto") session.optJSONObject("auto") ?: error("REMOTE_DJ_WORKSPACE_MISSING") else null
        if (workspace != null) {
            require(workspace.optString("djProfile", "adaptive") in listOf("adaptive", "long_blend", "cuts_drops", "open_format"))
            require(workspace.toString().length <= 131072)
            require(session != null && session.optInt("v") == 1 && session.optJSONArray("queue")?.length() in 1..46)
        }
        val position = state.optDouble("position_sec", 0.0).takeIf { it.isFinite() && it >= 0 && it <= 604800 } ?: 0.0
        if (session?.optInt("v") == 1) {
            val queue = session.optJSONArray("queue")
            if (queue != null && queue.length() in 1..46) {
                val rows = JSONArray(); val keys = mutableSetOf<String>()
                for (i in 0 until queue.length()) {
                    val entry = queue.getJSONObject(i)
                    require(entry.optString("queueId").isNotBlank() && keys.add(entry.getString("queueId")))
                    rows.put(row(entry))
                }
                val index = session.optInt("index", 0).coerceIn(0, rows.length() - 1)
                return Restored(rows, index, (position * 1000).toLong(), session.optBoolean("shuffle"),
                    when (session.optString("repeat")) { "all" -> Player.REPEAT_MODE_ALL; "one" -> Player.REPEAT_MODE_ONE; else -> Player.REPEAT_MODE_OFF }, workspace, queue, session.optJSONObject("radio"))
            }
        }
        val track = payload.optJSONObject("track") ?: return null
        return Restored(JSONArray().put(row(track)), 0, (position * 1000).toLong(), false, Player.REPEAT_MODE_OFF)
    }
}
