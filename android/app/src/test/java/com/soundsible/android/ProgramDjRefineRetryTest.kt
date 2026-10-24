package com.soundsible.android

import org.junit.Assert.*
import org.junit.Test

class ProgramDjRefineRetryTest {
    @Test fun pendingAnalysisAndFailuresRetryWithoutConcurrentRequests() {
        val retry = ProgramDjRefineRetry()
        assertTrue(retry.begin("a>b", 0))
        assertFalse(retry.begin("a>b", 9000))
        retry.finish("a>b", false)
        assertFalse(retry.begin("a>b", 1999))
        assertTrue(retry.begin("a>b", 2000))
        retry.finish("a>b", false)
        assertTrue(retry.begin("a>b", 4000))
        retry.finish("a>b", true)
        assertFalse(retry.begin("a>b", 9000))
    }
    @Test fun staleAnswerCannotSettleANewSeamAndClearAllowsANewSession() {
        val retry = ProgramDjRefineRetry()
        assertTrue(retry.begin("a>b", 0))
        assertTrue(retry.begin("b>c", 0))
        retry.finish("a>b", true)
        assertFalse(retry.begin("b>c", 5000))
        retry.finish("b>c", false)
        retry.clear()
        assertTrue(retry.begin("b>c", 0))
    }
}
