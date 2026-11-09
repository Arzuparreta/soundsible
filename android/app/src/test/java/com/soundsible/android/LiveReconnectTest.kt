package com.soundsible.android

import org.junit.Assert.assertEquals
import org.junit.Test

class LiveReconnectTest {
    private class Clock {
        var now = 0L
        private val pending = mutableMapOf<Runnable, Long>()
        fun post(task: Runnable, delay: Long) { pending[task] = now + delay }
        fun remove(task: Runnable) { pending.remove(task) }
        fun advance(delay: Long) {
            val end = now + delay
            while (true) {
                val next = pending.minByOrNull { it.value }?.takeIf { it.value <= end } ?: break
                now = next.value
                pending.remove(next.key)
                next.key.run()
            }
            now = end
        }
    }

    private val clock = Clock()
    private var owns = true
    private var retries = 0
    private var exhausted = 0
    private val recovery = LiveReconnect(clock::post, clock::remove, { owns }, { retries++ }, { exhausted++ })

    @Test fun spontaneousTransportRecoveryCancelsRestartBeforeMediaQualification() {
        recovery.lost()
        clock.advance(400)
        recovery.transportConnected()
        clock.advance(5_000)
        assertEquals(0, retries)
        assertEquals(0, exhausted)
        recovery.connected() // Sustained media confirms recovery after five seconds.
        clock.advance(60_000)
        assertEquals(0, retries)
        assertEquals(0, exhausted)
    }

    @Test fun transportWithoutMediaStillExhaustsTheOriginalDeadline() {
        recovery.lost()
        clock.advance(400)
        recovery.transportConnected()
        clock.advance(29_599)
        assertEquals(0, exhausted)
        clock.advance(1)
        assertEquals(1, exhausted)
        assertEquals(0, retries)
    }

    @Test fun transportBurstsKeepAttemptCountAndBackoffUntilMediaIsHealthy() {
        recovery.lost()
        clock.advance(1_000)
        assertEquals(1, retries)
        recovery.transportConnected()
        recovery.lost()
        clock.advance(1_999)
        assertEquals(1, retries)
        clock.advance(1)
        assertEquals(2, retries)
        recovery.transportConnected()
        recovery.lost()
        clock.advance(3_999)
        assertEquals(2, retries)
        clock.advance(1)
        assertEquals(3, retries)
        recovery.transportConnected()
        recovery.lost()
        assertEquals(1, exhausted)
        clock.advance(60_000)
        assertEquals(3, retries)
        assertEquals(1, exhausted)
    }

    @Test fun mediaQualificationStartsANewBudgetForALaterLoss() {
        recovery.lost()
        clock.advance(1_000)
        recovery.transportConnected()
        recovery.connected()
        clock.advance(60_000)
        recovery.lost()
        clock.advance(999)
        assertEquals(1, retries)
        clock.advance(1)
        assertEquals(2, retries)
        assertEquals(0, exhausted)
    }

    @Test fun cancelledOrStaleOwnerCannotRunRecovery() {
        recovery.lost()
        owns = false
        clock.advance(31_000)
        assertEquals(0, retries)
        assertEquals(0, exhausted)
        recovery.cancel()
        owns = true
        clock.advance(60_000)
        assertEquals(0, retries)
        assertEquals(0, exhausted)
    }
}
