package com.soundsible.android

import org.junit.Assert.*
import org.junit.Test
import org.webrtc.RTCStats
import org.webrtc.RTCStatsReport

class LiveDiagnosticsTest {
    @Test fun keepsMediaEvidenceWithoutExportingTransportCredentials() {
        val reports = linkedMapOf(
            "private-source-id" to RTCStats(1000, "media-source", "private-source-id", mapOf(
                "audioLevel" to .7, "totalAudioEnergy" to 42.0, "trackIdentifier" to "private-track")),
            "private-rtp-id" to RTCStats(1000, "inbound-rtp", "private-rtp-id", mapOf(
                "bytesReceived" to 1024L, "packetsLost" to 3, "concealedSamples" to 480L,
                "silentConcealedSamples" to 240L, "codecId" to "private-codec")),
            "pair" to RTCStats(1000, "candidate-pair", "pair", mapOf(
                "nominated" to true, "currentRoundTripTime" to .01, "localCandidateId" to "private-address")),
            "unselected" to RTCStats(1000, "candidate-pair", "unselected", mapOf("nominated" to false)),
            "candidate" to RTCStats(1000, "local-candidate", "candidate", mapOf("address" to "private-address")),
        )
        val stats = LiveDiagnostics.stats(RTCStatsReport(1000, reports))
        assertEquals(3, stats.length())
        assertEquals(.7, stats.getJSONObject(0).getDouble("audioLevel"), .001)
        assertEquals(1024L, stats.getJSONObject(1).getLong("bytesReceived"))
        assertEquals(480L, stats.getJSONObject(1).getLong("concealedSamples"))
        assertEquals(.01, stats.getJSONObject(2).getDouble("currentRoundTripTime"), .001)
        assertFalse(stats.toString().contains("private"))
    }
}
