package com.soundsible.android

import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** A real TLS OPTIONS stall is cancelled without network work on the player looper. */
@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
class LiveHandshakeTest {
    @Test fun cancelStalledHandshake() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val connection = EngineConnection.shared(instrumentation.targetContext)
        connection.clearSession(true)
        connection.configure(InstrumentationRegistry.getArguments().getString("tlsOrigin")!!)
        val peer = LivePeer(instrumentation.targetContext, connection,
            "https://10.0.2.2:58443/__fixture/slow-handshake", "isolated", true, { fail("Cancelled handshake emitted peer state") })
        val worker = Executors.newSingleThreadExecutor()
        try {
            val start = worker.submit<Boolean> { runCatching { peer.start() }.isFailure }
            Thread.sleep(500)
            assertFalse("OPTIONS stall was not reached", start.isDone)
            val before = System.nanoTime()
            instrumentation.runOnMainSync { peer.cancel() }
            assertTrue("Cancelled handshake unexpectedly completed", start.get(3, TimeUnit.SECONDS))
            assertTrue("Cancellation waited for the ten-second server stall", System.nanoTime() - before < TimeUnit.SECONDS.toNanos(3))
        } finally { peer.cancel(); worker.submit { peer.close() }.get(3, TimeUnit.SECONDS); worker.shutdownNow(); connection.clearSession(true) }
    }
}
