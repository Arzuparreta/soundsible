package com.soundsible.android

import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.RTCStatsReport
import java.util.concurrent.CopyOnWriteArraySet

/** Opt-in, in-process test observations. Never exports SDP, addresses, tokens or PCM. */
internal object LiveDiagnostics {
    val observers = CopyOnWriteArraySet<(JSONObject) -> Unit>()
    private val counters = setOf("packetsSent", "packetsReceived", "bytesSent", "bytesReceived",
        "packetsLost", "jitter", "roundTripTime", "currentRoundTripTime", "totalRoundTripTime",
        "audioLevel", "totalAudioEnergy", "totalSamplesDuration", "totalSamplesReceived",
        "concealedSamples", "silentConcealedSamples", "concealmentEvents", "jitterBufferDelay",
        "jitterBufferEmittedCount", "insertedSamplesForDeceleration", "removedSamplesForAcceleration")
    private val types = setOf("inbound-rtp", "outbound-rtp", "remote-inbound-rtp", "media-source", "candidate-pair")

    fun emit(event: String, values: () -> JSONObject) {
        if (observers.isEmpty()) return
        runCatching {
            val observation = values().put("event", event).put("elapsedMs", android.os.SystemClock.elapsedRealtime())
            for (observer in observers) runCatching { observer(observation) }
        }
    }

    fun stats(report: RTCStatsReport): JSONArray = JSONArray().apply {
        for (stat in report.statsMap.values) {
            if (stat.type !in types) continue
            // Only the selected transport pair matters; never include candidate IDs/IPs.
            if (stat.type == "candidate-pair" && stat.members["nominated"] != true) continue
            val item = JSONObject().put("type", stat.type).put("timestampUs", stat.timestampUs)
            for ((key, value) in stat.members) {
                if (key in counters && value is Number) item.put(key, value)
            }
            put(item)
        }
    }
}
