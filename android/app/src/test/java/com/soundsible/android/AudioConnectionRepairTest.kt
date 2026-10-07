package com.soundsible.android

import java.io.EOFException
import java.io.IOException
import java.net.SocketTimeoutException
import org.junit.Assert.*
import org.junit.Test

class AudioConnectionRepairTest {
    private val stale = IOException("unexpected end of stream on https://fixture/", EOFException())
    @Test fun repairsOnlyFirstPooledHeaderEof() {
        assertTrue(AudioConnectionRepair.allowed(stale, false, false, false))
        assertFalse(AudioConnectionRepair.allowed(stale, true, false, false))
        assertFalse(AudioConnectionRepair.allowed(stale, false, true, false))
        assertFalse(AudioConnectionRepair.allowed(stale, false, false, true))
    }
    @Test fun doesNotRepairBodyTimeoutOrTrustFailure() {
        for (error in listOf(EOFException(), SocketTimeoutException(), javax.net.ssl.SSLHandshakeException("certificate"), IOException("body cut", EOFException()))) {
            assertFalse(AudioConnectionRepair.allowed(error, false, false, false))
        }
    }
}
