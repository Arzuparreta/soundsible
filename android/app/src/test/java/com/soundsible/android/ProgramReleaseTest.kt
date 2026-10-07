package com.soundsible.android

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class ProgramReleaseTest {
    @Test fun readsTheRecordAndThePlaceOnIt() {
        val row = JSONObject().put("album_artist", "Daft Punk").put("track_number", 3).put("disc_number", 1).put("year", 2001)
        assertEquals(ProgramRelease("Daft Punk", 3, 1, 2001), ProgramRelease.read(row))
    }

    @Test fun leavesWhatIsAbsentOrNullUnset() {
        assertEquals(ProgramRelease(null, null, null, null), ProgramRelease.read(JSONObject()))
        val row = JSONObject().put("album_artist", JSONObject.NULL).put("track_number", JSONObject.NULL)
        assertEquals(ProgramRelease(null, null, null, null), ProgramRelease.read(row))
    }

    @Test fun neverGuessesAPositionOrAYear() {
        // An upload date read as a year, a fraction, a zero, text where a number belongs.
        val row = JSONObject().put("year", 20101012).put("track_number", 2.5).put("disc_number", 0)
        assertEquals(ProgramRelease(null, null, null, null), ProgramRelease.read(row))
        assertEquals(null, ProgramRelease.read(JSONObject().put("track_number", "three")).trackNumber)
        assertEquals(null, ProgramRelease.read(JSONObject().put("track_number", 1000)).trackNumber)
    }

    @Test(expected = IllegalArgumentException::class) fun refusesAnOversizedAlbumArtist() {
        ProgramRelease.read(JSONObject().put("album_artist", "x".repeat(4097)))
    }

    @Test fun travelsThroughADeviceHandoffUnchanged() {
        val sent = ProgramRelease("Daft Punk", 3, 1, 2001).writeTo(JSONObject().put("id", "A1111111111"))
        assertEquals(ProgramRelease("Daft Punk", 3, 1, 2001), ProgramRelease.read(JSONObject(sent.toString())))
        // Nothing known, nothing written: a handoff from an older device reads the same.
        assertEquals(listOf("id"), ProgramRelease(null, null, null, null).writeTo(JSONObject().put("id", "x")).keys().asSequence().toList())
    }
}
