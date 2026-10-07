package com.soundsible.android

import org.junit.Assert.*
import org.junit.Test

class ProgramLoudnessTest {
    @Test fun sharedGainVectorsMatchTheNativePolicy() {
        val stream = javaClass.classLoader!!.getResourceAsStream("loudness_gain.tsv")!!
        stream.bufferedReader().useLines { lines ->
            for (line in lines.filter { it.isNotBlank() && !it.startsWith("#") }) {
                val values = line.split(Regex("\\s+")).map(String::toDouble)
                assertEquals(line, values[2], ProgramLoudness.gainDb(values[0], values[1]), 0.000001)
            }
        }
    }
    @Test fun disabledAndUnmeasuredNeverMuteOrInventAMeasurement() {
        for (facts in listOf(ProgramLoudness.Facts(-14.0, -1.0), ProgramLoudness.Facts(), ProgramLoudness.Facts(Double.NaN, 0.0))) {
            assertEquals(1.0, ProgramLoudness.levelFor(facts, false), 0.0)
        }
        assertEquals(1.0, ProgramLoudness.levelFor(null, true), 0.0)
        assertEquals(0.6309573444801932, ProgramLoudness.levelFor(ProgramLoudness.Facts(), true), 0.000001)
        assertEquals(1.0, ProgramLoudness.linear(Double.NaN), 0.0)
        assertEquals(0.05, ProgramLoudness.linear(-1000.0), 0.0)
        assertEquals(4.0, ProgramLoudness.linear(1000.0), 0.0)
    }
    @Test fun anExplicitCompleteAlbumPreservesDynamicsButShuffleAndMissingContextUseIndividualGains() {
        val quiet = ProgramLoudness.Facts(-24.0, -10.0, 60.0)
        val loud = ProgramLoudness.Facts(-12.0, -1.0, 180.0)
        val album = listOf(quiet, loud)
        val shared = ProgramLoudness.levelFor(quiet, true, contextKind = "album", contextId = "confirmed-album", siblings = album)
        assertEquals(0.5727297072924131, shared, 0.000001)
        assertEquals(shared, ProgramLoudness.levelFor(loud, true, contextKind = "album", contextId = "confirmed-album", siblings = album), 0.0)
        assertTrue(shared < 1)
        assertEquals(ProgramLoudness.linear(6.0), ProgramLoudness.levelFor(quiet, true, true, "album", "confirmed-album", album), 0.000001)
        assertEquals(ProgramLoudness.linear(6.0), ProgramLoudness.levelFor(quiet, true, siblings = album), 0.000001)
        assertNull(ProgramLoudness.albumReference(album + ProgramLoudness.Facts()))
        assertNotNull(ProgramLoudness.albumReference(List(9) { quiet } + ProgramLoudness.Facts()))
        assertNull(ProgramLoudness.albumReference(emptyList()))
    }
}
