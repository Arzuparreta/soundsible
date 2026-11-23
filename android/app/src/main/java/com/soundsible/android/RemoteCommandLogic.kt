package com.soundsible.android

import org.json.JSONArray
import org.json.JSONObject

internal class RemoteCommandRejected(val reason: String) : IllegalStateException(reason)

/** Pure wire formatting, validation and queue-target math for remote control. */
internal object RemoteCommandLogic {
    const val PROTOCOL = 1

    val supportedCommands: List<String> = listOf(
        "transport.play",
        "transport.pause",
        "transport.next",
        "transport.previous",
        "transport.seek",
        "transport.set_shuffle",
        "transport.set_repeat",
        "play.tracks",
        "queue.add",
        "queue.move",
        "queue.remove",
        "queue.play_entry",
        "radio.start",
        "radio.stop",
        "dj.start",
        "dj.start_from_current",
        "dj.stop",
        "dj.place",
        "dj.add_source",
        "dj.remove_source",
        "dj.change_session",
        "dj.repair",
        "dj.set_mixing",
        "session.export",
        "session.import",
        "session.release",
    )

    /** Act on this device's own queue, so a Live listening session refuses them. */
    val ownQueueCommands: Set<String> = setOf(
        "transport.play", "transport.pause", "transport.next", "transport.previous", "transport.seek",
        "transport.set_shuffle", "transport.set_repeat", "queue.add", "queue.move", "queue.remove",
        "queue.play_entry", "radio.stop", "dj.start_from_current", "dj.set_mixing",
    )

    /** Need a current item: `nothing_playing` without one. */
    val currentItemCommands: Set<String> = setOf(
        "transport.play", "transport.pause", "transport.next", "transport.previous", "transport.seek", "dj.start_from_current",
    )

    /** Need a running DJ session: `invalid_state` without one. */
    val djSessionCommands: Set<String> = setOf(
        "dj.stop", "dj.place", "dj.add_source", "dj.remove_source", "dj.change_session", "dj.repair",
    )

    fun formFactor(smallestScreenWidthDp: Int): String =
        if (smallestScreenWidthDp >= 600) "tablet" else "phone"

    fun registration(
        deviceId: String,
        deviceName: String,
        instanceId: String,
        smallestScreenWidthDp: Int,
        commands: List<String> = supportedCommands,
    ): JSONObject = JSONObject()
        .put("device_id", deviceId)
        .put("device_name", deviceName)
        .put("device_type", "android")
        .put("form_factor", formFactor(smallestScreenWidthDp))
        .put("instance_id", instanceId)
        .put("protocol", PROTOCOL)
        .put("commands", JSONArray(commands))

    fun idleLive(): JSONObject = JSONObject()
        .put("phase", "idle")
        .put("duration", 0.0)
        .put("dj", JSONObject.NULL)

    fun djLive(
        phase: String,
        repairing: Boolean,
        pendingDirection: Boolean,
        mixing: Boolean,
        transition: JSONObject,
    ): JSONObject = JSONObject()
        .put("phase", phase)
        .put("repairing", repairing)
        .put("pending_direction", pendingDirection)
        .put("mixing", mixing)
        .put("transition", transition)

    fun live(
        hasItem: Boolean,
        isPlaying: Boolean,
        playWhenReady: Boolean,
        isBuffering: Boolean,
        isIdle: Boolean,
        hasError: Boolean,
        durationSec: Double,
        dj: JSONObject?,
    ): JSONObject {
        val phase = when {
            !hasItem -> "idle"
            hasError -> "error"
            isBuffering -> "buffering"
            isPlaying -> "playing"
            playWhenReady && isIdle -> "loading"
            else -> "paused"
        }
        val duration = if (durationSec.isFinite() && durationSec >= 0.0) durationSec else 0.0
        return JSONObject()
            .put("phase", phase)
            .put("duration", duration)
            .put("dj", dj ?: JSONObject.NULL)
    }

    /** Repeat modes match Media3 Player.REPEAT_MODE_{OFF=0, ONE=1, ALL=2}. */
    fun parseRepeatMode(mode: String): Int? = when (mode) {
        "off" -> 0
        "one" -> 1
        "all" -> 2
        else -> null
    }

    fun parseSeekSeconds(args: JSONObject): Double? {
        if (!args.has("position_sec") || args.isNull("position_sec")) return null
        val seconds = args.optDouble("position_sec", Double.NaN)
        return seconds.takeIf { it.isFinite() && it >= 0.0 && it <= 604800.0 }
    }

    fun wireTrackRow(track: JSONObject): JSONObject {
        val pending = track.optJSONObject("pendingResolve")
        val podcast = track.optString("media_kind") == "podcast_episode"
        val source = when {
            pending != null -> "pending"
            track.optString("source") == "preview" -> if (podcast) "podcast" else "preview"
            else -> "local"
        }
        val rawId = track.getString("id")
        val id = if (source == "preview" && !Regex("^[A-Za-z0-9_-]{11}$").matches(rawId)) {
            track.optString("youtube_id").takeIf { Regex("^[A-Za-z0-9_-]{11}$").matches(it) } ?: rawId
        } else rawId
        return JSONObject()
            .put("source", source)
            .put("item_id", track.optString("item_id").takeIf { it.isNotBlank() && it != "null" })
            .put("id", id)
            .put("title", track.optString("title"))
            .put("artist", track.optString("artist"))
            .put("album", track.optString("album"))
            .put("duration", track.optDouble("duration", 0.0).takeIf { it.isFinite() && it >= 0.0 } ?: 0.0)
            .apply {
                ProgramRelease.read(track).writeTo(this)
                if (pending != null) put("pendingResolve", JSONObject(pending.toString()))
                for (name in listOf("loudness_lufs", "loudness_peak_dbtp")) {
                    track.optDouble(name, Double.NaN).takeIf { it.isFinite() }?.let { put(name, it) }
                }
                if (podcast) {
                    put("mediaKind", "podcast_episode")
                    put("enclosure", track.optString("podcast_enclosure_url"))
                    put("episodeGuid", track.optString("podcast_episode_guid"))
                    put("feedId", track.optString("podcast_feed_id"))
                }
            }
    }

    fun wireTrackRows(tracks: JSONArray): JSONArray = JSONArray().apply {
        for (i in 0 until tracks.length()) put(wireTrackRow(tracks.getJSONObject(i)))
    }

    /** Target index for Media3 Player.moveMediaItem, or null when already at that position. */
    fun normalMoveTarget(count: Int, fromIndex: Int, beforeIndex: Int?): Int? {
        if (fromIndex !in 0 until count) return null
        val target = if (beforeIndex == null) {
            count - 1
        } else {
            if (beforeIndex !in 0 until count || beforeIndex == fromIndex) return null
            if (fromIndex < beforeIndex) beforeIndex - 1 else beforeIndex
        }
        return target.takeIf { it != fromIndex }
    }

    sealed class DjMovePlan {
        data class Move(val toIndex: Int) : DjMovePlan()
        data object NoOp : DjMovePlan()
        data object Locked : DjMovePlan()
    }

    /**
     * Maps a contract `before_queue_id` move to the drag index `ProgramDjSession.editBlock` expects,
     * rejecting any move whose source or destination block is playing, armed, mixing or history.
     */
    fun djMoveTarget(
        rows: List<ProgramDjRoutePolicy.RouteRow>,
        queueId: String,
        beforeQueueId: String?,
        editableFrom: Int,
        protectedKeys: Set<String>,
    ): DjMovePlan {
        val movingBlock = ProgramDjRoutePolicy.block(rows, queueId) ?: return DjMovePlan.NoOp
        val movingSet = movingBlock.toSet()
        val movingStart = rows.indexOfFirst { it.key in movingSet }
        if (movingStart < editableFrom || movingBlock.any { it in protectedKeys }) return DjMovePlan.Locked
        if (beforeQueueId == null) {
            val movingEnd = rows.indexOfLast { it.key in movingSet }
            if (movingEnd == rows.lastIndex) return DjMovePlan.NoOp
            val tailBlock = ProgramDjRoutePolicy.block(rows, rows.last().key) ?: return DjMovePlan.Locked
            if (tailBlock.any { it in protectedKeys }) return DjMovePlan.Locked
            return DjMovePlan.Move(rows.lastIndex)
        }
        if (beforeQueueId in movingSet) return DjMovePlan.NoOp
        val beforeBlock = ProgramDjRoutePolicy.block(rows, beforeQueueId) ?: return DjMovePlan.NoOp
        val beforeStart = rows.indexOfFirst { it.key == beforeBlock.first() }
        if (beforeStart < editableFrom || beforeBlock.any { it in protectedKeys }) return DjMovePlan.Locked
        if (beforeStart < movingStart) return DjMovePlan.Move(beforeStart)
        val previousIndex = beforeStart - 1
        if (previousIndex < 0 || rows[previousIndex].key in movingSet) return DjMovePlan.NoOp
        val previousBlock = ProgramDjRoutePolicy.block(rows, rows[previousIndex].key) ?: return DjMovePlan.Locked
        if (previousBlock.any { it in protectedKeys }) return DjMovePlan.Locked
        return DjMovePlan.Move(previousIndex)
    }

    fun djRemoveLocked(
        rows: List<ProgramDjRoutePolicy.RouteRow>,
        queueId: String,
        protectedKeys: Set<String>,
    ): Boolean = ProgramDjRoutePolicy.removed(rows, queueId).any { it in protectedKeys }

    sealed class PublishAnswer {
        data class Ok(val rev: Long?) : PublishAnswer()
        data object Stale : PublishAnswer()
        data object Failed : PublishAnswer()
    }

    fun parseStatePublishAnswer(httpCode: Int, bodyText: String): PublishAnswer {
        if (httpCode !in 200..299) return PublishAnswer.Failed
        val json = runCatching { if (bodyText.isBlank()) JSONObject() else JSONObject(bodyText) }.getOrNull()
            ?: return PublishAnswer.Failed
        if (json.optString("status") == "stale") return PublishAnswer.Stale
        val rev = if (json.has("rev") && !json.isNull("rev")) json.optLong("rev", -1L).takeIf { it >= 0L } else null
        return PublishAnswer.Ok(rev)
    }

    fun parseTransferOutcome(httpCode: Int, bodyText: String): Boolean {
        if (httpCode !in 200..299) return false
        val json = runCatching { if (bodyText.isBlank()) JSONObject() else JSONObject(bodyText) }.getOrNull()
            ?: return false
        return json.optString("status") == "applied"
    }

    fun ackApplied(rev: Long? = null, state: JSONObject? = null): JSONObject = JSONObject()
        .put("status", "applied")
        .apply {
            rev?.let { put("rev", it) }
            state?.let { put("state", it) }
        }

    fun ackRejected(reason: String): JSONObject = JSONObject()
        .put("status", "rejected")
        .put("reason", reason)
}
