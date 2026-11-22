package com.soundsible.android

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RemoteCommandLogicTest {
    @Test fun registrationIncludesProtocolFormFactorInstanceAndCommands() {
        val phone = RemoteCommandLogic.registration("dev-1", "Pixel", "inst-1", 411)
        assertEquals("dev-1", phone.getString("device_id"))
        assertEquals("Pixel", phone.getString("device_name"))
        assertEquals("android", phone.getString("device_type"))
        assertEquals("phone", phone.getString("form_factor"))
        assertEquals("inst-1", phone.getString("instance_id"))
        assertEquals(1, phone.getInt("protocol"))
        val commands = phone.getJSONArray("commands")
        val declared = (0 until commands.length()).map { commands.getString(it) }
        assertTrue("transport.play" in declared)
        assertTrue("play.tracks" in declared)
        assertTrue("queue.move" in declared)
        assertTrue("dj.place" in declared)
        assertTrue("session.import" in declared)
        assertFalse("transport.set_volume" in declared)
        assertFalse("dj.promote" in declared)
        assertFalse("dj.avoid" in declared)

        val tablet = RemoteCommandLogic.registration("dev-2", "Tab", "inst-2", 600)
        assertEquals("tablet", tablet.getString("form_factor"))
    }

    @Test fun liveStateOmitsVolumeAndMapsPhases() {
        val playing = RemoteCommandLogic.live(
            hasItem = true, isPlaying = true, playWhenReady = true, isBuffering = false,
            isIdle = false, hasError = false, durationSec = 213.4, dj = null,
        )
        assertEquals("playing", playing.getString("phase"))
        assertEquals(213.4, playing.getDouble("duration"), 0.001)
        assertFalse(playing.has("volume"))
        assertTrue(playing.isNull("dj"))

        val buffering = RemoteCommandLogic.live(
            hasItem = true, isPlaying = false, playWhenReady = true, isBuffering = true,
            isIdle = false, hasError = false, durationSec = 100.0,
            dj = RemoteCommandLogic.djLive(
                phase = "ready", repairing = false, pendingDirection = true, mixing = true,
                transition = JSONObject().put("status", "armed").put("next_queue_id", "q-2").put("at", 180.2),
            ),
        )
        assertEquals("buffering", buffering.getString("phase"))
        val dj = buffering.getJSONObject("dj")
        assertEquals("ready", dj.getString("phase"))
        assertFalse(dj.getBoolean("repairing"))
        assertTrue(dj.getBoolean("pending_direction"))
        assertTrue(dj.getBoolean("mixing"))
        assertEquals("armed", dj.getJSONObject("transition").getString("status"))
        assertEquals("q-2", dj.getJSONObject("transition").getString("next_queue_id"))

        assertEquals("idle", RemoteCommandLogic.live(false, false, false, false, true, false, -5.0, null).getString("phase"))
        assertEquals("error", RemoteCommandLogic.live(true, false, true, true, false, true, 10.0, null).getString("phase"))
        assertEquals("loading", RemoteCommandLogic.live(true, false, true, false, true, false, 10.0, null).getString("phase"))
        assertEquals("paused", RemoteCommandLogic.live(true, false, false, false, false, false, 10.0, null).getString("phase"))
    }

    @Test fun parsesRepeatAndSeekArguments() {
        assertEquals(0, RemoteCommandLogic.parseRepeatMode("off"))
        assertEquals(1, RemoteCommandLogic.parseRepeatMode("one"))
        assertEquals(2, RemoteCommandLogic.parseRepeatMode("all"))
        assertNull(RemoteCommandLogic.parseRepeatMode("toggle"))

        assertEquals(42.5, RemoteCommandLogic.parseSeekSeconds(JSONObject().put("position_sec", 42.5))!!, 0.001)
        assertEquals(0.0, RemoteCommandLogic.parseSeekSeconds(JSONObject().put("position_sec", 0))!!, 0.001)
        assertNull(RemoteCommandLogic.parseSeekSeconds(JSONObject().put("position_sec", -1)))
        assertNull(RemoteCommandLogic.parseSeekSeconds(JSONObject().put("position_sec", JSONObject.NULL)))
        assertNull(RemoteCommandLogic.parseSeekSeconds(JSONObject()))
    }

    @Test fun convertsWireTracksToNativeQueueRows() {
        val local = RemoteCommandLogic.wireTrackRow(
            JSONObject().put("id", "track-1").put("title", "Song").put("artist", "Artist")
                .put("album_artist", "AA").put("track_number", 2).put("year", 2020)
                .put("loudness_lufs", -14.2)
        )
        assertEquals("local", local.getString("source"))
        assertEquals("track-1", local.getString("id"))
        assertEquals("AA", local.getString("album_artist"))
        assertEquals(2, local.getInt("track_number"))
        assertEquals(-14.2, local.getDouble("loudness_lufs"), 0.001)

        val preview = RemoteCommandLogic.wireTrackRow(
            JSONObject().put("id", "catalog:1").put("youtube_id", "A1234567890").put("source", "preview")
        )
        assertEquals("preview", preview.getString("source"))
        assertEquals("A1234567890", preview.getString("id"))

        val pending = RemoteCommandLogic.wireTrackRow(
            JSONObject().put("id", "deezer:1").put("source", "preview")
                .put("pendingResolve", JSONObject().put("catalogItemId", "deezer:1").put("title", "T").put("artist", "A"))
        )
        assertEquals("pending", pending.getString("source"))
        assertTrue(pending.has("pendingResolve"))

        val podcast = RemoteCommandLogic.wireTrackRow(
            JSONObject().put("id", "ep-1").put("source", "preview").put("media_kind", "podcast_episode")
                .put("podcast_enclosure_url", "https://example.test/ep.mp3")
                .put("podcast_episode_guid", "ep-1").put("podcast_feed_id", "feed-1")
        )
        assertEquals("podcast", podcast.getString("source"))
        assertEquals("podcast_episode", podcast.getString("mediaKind"))
        assertEquals("https://example.test/ep.mp3", podcast.getString("enclosure"))
    }

    @Test fun computesNormalMoveTargets() {
        // [0, 1, 2, 3]
        assertEquals(3, RemoteCommandLogic.normalMoveTarget(4, 1, null))
        assertNull(RemoteCommandLogic.normalMoveTarget(4, 3, null))
        assertEquals(2, RemoteCommandLogic.normalMoveTarget(4, 1, 3))
        assertNull(RemoteCommandLogic.normalMoveTarget(4, 1, 2))
        assertEquals(1, RemoteCommandLogic.normalMoveTarget(4, 3, 1))
        assertNull(RemoteCommandLogic.normalMoveTarget(4, 1, 1))
    }

    @Test fun computesDjMoveTargetsAndHonoursLocksAndBridges() {
        val rows = listOf(
            ProgramDjRoutePolicy.RouteRow("playing", "generated"),
            ProgramDjRoutePolicy.RouteRow("armed", "generated"),
            ProgramDjRoutePolicy.RouteRow("br1", "bridge", owner = "req1"),
            ProgramDjRoutePolicy.RouteRow("req1", "user"),
            ProgramDjRoutePolicy.RouteRow("gen2", "generated"),
            ProgramDjRoutePolicy.RouteRow("gen3", "generated"),
        )
        val locked = setOf("playing", "armed")
        val editableFrom = 2

        // Locked source or locked destination
        assertEquals(RemoteCommandLogic.DjMovePlan.Locked, RemoteCommandLogic.djMoveTarget(rows, "playing", "gen3", editableFrom, locked))
        assertEquals(RemoteCommandLogic.DjMovePlan.Locked, RemoteCommandLogic.djMoveTarget(rows, "armed", "gen3", editableFrom, locked))
        assertEquals(RemoteCommandLogic.DjMovePlan.Locked, RemoteCommandLogic.djMoveTarget(rows, "gen3", "armed", editableFrom, locked))

        // Move gen3 up before req1 (lands at bridge start index 2)
        val up = RemoteCommandLogic.djMoveTarget(rows, "gen3", "req1", editableFrom, locked) as RemoteCommandLogic.DjMovePlan.Move
        assertEquals(2, up.toIndex)
        assertEquals(
            listOf("playing", "armed", "gen3", "br1", "req1", "gen2"),
            ProgramDjRoutePolicy.moveToIndex(rows, "gen3", up.toIndex, editableFrom - 1),
        )

        // Move req1 (and its bridge) down before gen3 (lands after gen2 at index 4)
        val down = RemoteCommandLogic.djMoveTarget(rows, "req1", "gen3", editableFrom, locked) as RemoteCommandLogic.DjMovePlan.Move
        assertEquals(4, down.toIndex)
        assertEquals(
            listOf("playing", "armed", "gen2", "br1", "req1", "gen3"),
            ProgramDjRoutePolicy.moveToIndex(rows, "req1", down.toIndex, editableFrom - 1),
        )

        // Move to end (beforeQueueId == null)
        val toEnd = RemoteCommandLogic.djMoveTarget(rows, "req1", null, editableFrom, locked) as RemoteCommandLogic.DjMovePlan.Move
        assertEquals(5, toEnd.toIndex)
        assertEquals(
            listOf("playing", "armed", "gen2", "gen3", "br1", "req1"),
            ProgramDjRoutePolicy.moveToIndex(rows, "req1", toEnd.toIndex, editableFrom - 1),
        )

        // Already before gen2 -> no-op
        assertEquals(RemoteCommandLogic.DjMovePlan.NoOp, RemoteCommandLogic.djMoveTarget(rows, "req1", "gen2", editableFrom, locked))
        assertEquals(RemoteCommandLogic.DjMovePlan.NoOp, RemoteCommandLogic.djMoveTarget(rows, "gen3", null, editableFrom, locked))
        assertEquals(RemoteCommandLogic.DjMovePlan.NoOp, RemoteCommandLogic.djMoveTarget(rows, "req1", "br1", editableFrom, locked))

        // Remove lock check
        assertTrue(RemoteCommandLogic.djRemoveLocked(rows, "armed", locked))
        assertFalse(RemoteCommandLogic.djRemoveLocked(rows, "req1", locked))
    }

    @Test fun parsesPublishAndTransferResponses() {
        assertEquals(RemoteCommandLogic.PublishAnswer.Ok(17L), RemoteCommandLogic.parseStatePublishAnswer(200, """{"status":"ok","rev":17}"""))
        assertEquals(RemoteCommandLogic.PublishAnswer.Ok(null), RemoteCommandLogic.parseStatePublishAnswer(200, """{"status":"ok"}"""))
        assertEquals(RemoteCommandLogic.PublishAnswer.Stale, RemoteCommandLogic.parseStatePublishAnswer(200, """{"status":"stale"}"""))
        assertEquals(RemoteCommandLogic.PublishAnswer.Failed, RemoteCommandLogic.parseStatePublishAnswer(500, """{"error":"boom"}"""))

        assertTrue(RemoteCommandLogic.parseTransferOutcome(200, """{"status":"applied","rev":9}"""))
        assertFalse(RemoteCommandLogic.parseTransferOutcome(409, """{"status":"rejected","reason":"nothing_playing","step":"export"}"""))
        assertFalse(RemoteCommandLogic.parseTransferOutcome(503, """{"status":"unreachable","reason":"offline"}"""))

        val applied = RemoteCommandLogic.ackApplied(rev = 5L)
        assertEquals("applied", applied.getString("status"))
        assertEquals(5L, applied.getLong("rev"))
        val rejected = RemoteCommandLogic.ackRejected("not_found")
        assertEquals("rejected", rejected.getString("status"))
        assertEquals("not_found", rejected.getString("reason"))
    }
}
