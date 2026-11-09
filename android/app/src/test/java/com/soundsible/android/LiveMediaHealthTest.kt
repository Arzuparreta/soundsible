package com.soundsible.android

import com.soundsible.android.LiveMediaHealth.State.*
import org.junit.Assert.assertEquals
import org.junit.Test

class LiveMediaHealthTest {
    private val health = LiveMediaHealth().apply { reset(0) }

    private fun sample(timeMs: Long, packets: Long, active: Boolean = true) =
        health.observe(timeMs, packets, active)

    @Test fun continuousPacketsMustGrowForFiveSecondsBeforeHealthy() {
        assertEquals(WAITING, sample(0, 0))
        for (second in 1L..5L) assertEquals(WAITING, sample(second * 1_000, second * 50))
        assertEquals(HEALTHY, sample(6_000, 300))
        assertEquals(HEALTHY, sample(7_000, 350))
    }

    @Test fun silentAudioWithGrowingRtpRemainsHealthy() {
        // No amplitude/decoded-PCM input: even sparse silence packets are real media.
        sample(0, 0)
        for (second in 1L..6L) sample(second * 1_000, second)
        for (second in 7L..20L) assertEquals(HEALTHY, sample(second * 1_000, second))
    }

    @Test fun emptyStartupGetsTenSecondsOfGrace() {
        assertEquals(WAITING, sample(0, 0))
        assertEquals(WAITING, sample(9_999, 0))
        assertEquals(STALLED, sample(10_000, 0))
        assertEquals(STALLED, sample(30_000, 0))
    }

    @Test fun initialNonzeroSnapshotAloneDoesNotEstablishProgress() {
        assertEquals(WAITING, sample(0, 8))
        assertEquals(WAITING, sample(9_999, 8))
        assertEquals(STALLED, sample(10_000, 8))
    }

    @Test fun shortBurstNeverBecomesHealthyAndStallsFiveSecondsAfterReceipt() {
        sample(0, 0)
        assertEquals(WAITING, sample(1_000, 8))
        assertEquals(WAITING, sample(5_999, 8))
        assertEquals(STALLED, sample(6_000, 8))
    }

    @Test fun healthyStreamStallsFiveSecondsAfterItsLastProgress() {
        sample(0, 0)
        for (second in 1L..6L) sample(second * 1_000, second * 50)
        assertEquals(HEALTHY, sample(10_999, 300))
        assertEquals(STALLED, sample(11_000, 300))
        assertEquals(WAITING, sample(12_000, 350))
        for (second in 13L..16L) assertEquals(WAITING, sample(second * 1_000, second * 50))
        assertEquals(HEALTHY, sample(17_000, 850))
    }

    @Test fun constantSamplesInterruptInitialHealthyQualification() {
        sample(0, 0)
        for (second in 1L..4L) sample(second * 1_000, second * 50)
        assertEquals(WAITING, sample(5_000, 200))
        for (second in 6L..10L) assertEquals(WAITING, sample(second * 1_000, second * 50))
        assertEquals(HEALTHY, sample(11_000, 550))
    }

    @Test fun unobservedLongGapCannotQualifyAsSustainedRecovery() {
        sample(0, 0)
        sample(1_000, 8)
        assertEquals(WAITING, sample(20_000, 16))
        assertEquals(STALLED, sample(25_000, 16))
    }

    @Test fun pauseAndSuppressionNeverStallAndResumeStartsFreshGrace() {
        sample(0, 0)
        sample(1_000, 8)
        assertEquals(WAITING, sample(2_000, 8, active = false))
        assertEquals(WAITING, sample(100_000, 8, active = false))
        // Packets received while paused do not count as fresh progress on resume.
        assertEquals(WAITING, sample(200_000, 1_000))
        assertEquals(WAITING, sample(209_999, 1_000))
        assertEquals(STALLED, sample(210_000, 1_000))
    }

    @Test fun resumeRequiresSustainedProgressAgain() {
        sample(0, 0)
        for (second in 1L..6L) sample(second * 1_000, second * 50)
        assertEquals(WAITING, sample(7_000, 300, active = false))
        assertEquals(WAITING, sample(100_000, 300))
        for (second in 101L..105L) assertEquals(WAITING, sample(second * 1_000, second * 50))
        assertEquals(HEALTHY, sample(106_000, 5_300))
    }

    @Test fun counterResetCannotExtendTheLastMediaDeadline() {
        sample(0, 100)
        sample(1_000, 150)
        assertEquals(WAITING, sample(4_000, 0))
        assertEquals(WAITING, sample(5_999, 0))
        assertEquals(STALLED, sample(6_000, 0))
    }

    @Test fun counterResetNeedsFreshSustainedGrowth() {
        sample(0, 0)
        for (second in 1L..6L) sample(second * 1_000, second * 50)
        assertEquals(WAITING, sample(7_000, 0))
        for (second in 8L..12L) assertEquals(WAITING, sample(second * 1_000, second - 7))
        assertEquals(HEALTHY, sample(13_000, 6))
    }

    @Test fun explicitResetGivesNewPeerItsOwnBaselineAndGrace() {
        sample(0, 0)
        assertEquals(STALLED, sample(10_000, 0))
        health.reset(20_000)
        assertEquals(WAITING, sample(20_000, 8))
        assertEquals(WAITING, sample(29_999, 8))
        assertEquals(STALLED, sample(30_000, 8))
    }
}
