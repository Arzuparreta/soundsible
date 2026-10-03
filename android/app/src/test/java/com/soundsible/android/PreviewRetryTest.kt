package com.soundsible.android

import org.junit.Assert.*
import org.junit.Test

class PreviewRetryTest {
    @Test fun boundedAcrossLoadsAndManualCooldown() {
        var now = 0L
        val retry = PreviewRetry({ now }, { 0L })
        assertNull(retry.delay(502, null))
        assertEquals(2000L, retry.delay(503, null))
        try { retry.retry(); fail("cooldown bypass") } catch (_: IllegalArgumentException) {}
        now = 2000; retry.loaded()
        assertFalse(retry.pending)
        assertEquals(4000L, retry.delay(429, "bad"))
        now = 6000; assertNull(retry.delay(503, "1")); assertEquals(2, retry.attempts)
        now = 7000; retry.retry(); assertEquals(0, retry.attempts)
        assertEquals(0L, retry.delay(503, "0"))
    }
    @Test fun dateHeaderAndWindow() {
        var now = 0L
        val wall = 1445412480000L
        val retry = PreviewRetry({ now }, { wall + now })
        assertEquals(5000L, retry.delay(503, "Wed, 21 Oct 2015 07:28:05 GMT"))
        now = 29000; assertNull(retry.delay(429, "2")); assertEquals(2000L, retry.remaining())
        val long = PreviewRetry({ 0 }, { wall })
        assertNull(long.delay(503, "60")); assertEquals(60000L, long.remaining()); assertEquals(0, long.attempts)
    }
}
