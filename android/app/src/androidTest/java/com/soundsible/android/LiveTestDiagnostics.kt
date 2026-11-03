package com.soundsible.android

import android.util.Log
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Captured in the per-test Gradle logcat and the shard's continuous logcat. */
@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
internal class LiveTestDiagnostics(private val snapshot: () -> JSONObject, private val relay: () -> JSONObject?) : AutoCloseable {
    private val observer: (JSONObject) -> Unit = { Log.i(TAG, it.toString()); Unit }
    private val worker = Executors.newSingleThreadScheduledExecutor()
    init {
        LiveDiagnostics.observers.add(observer)
        worker.scheduleWithFixedDelay({
            runCatching {
                mark("sample")
                LivePeer.sampleAllDiagnostics()
                relay()?.let { value -> LiveDiagnostics.emit("relay.stats") { value } }
            }.onFailure { Log.i(TAG, JSONObject().put("event", "sample.failed").put("error", it.javaClass.simpleName).toString()) }
        }, 0, 1, TimeUnit.SECONDS)
    }
    fun mark(phase: String) {
        LiveDiagnostics.emit("test.$phase", snapshot)
    }
    override fun close() {
        worker.shutdownNow()
        LiveDiagnostics.observers.remove(observer)
    }
    companion object { private const val TAG = "LiveTestDiagnostics" }
}
