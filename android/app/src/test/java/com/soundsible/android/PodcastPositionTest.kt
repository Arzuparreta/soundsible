package com.soundsible.android

import org.junit.Assert.assertEquals
import org.junit.Test

class PodcastPositionTest {
    @Test fun clampsSeekToDurationAndZero() {
        assertEquals(0, PodcastPosition.skip(5000, 60000, -15))
        assertEquals(60000, PodcastPosition.skip(55000, 60000, 15))
        assertEquals(25000, PodcastPosition.skip(10000, -1, 15))
        assertEquals(Long.MAX_VALUE, PodcastPosition.skip(Long.MAX_VALUE - 1, -1, 15))
    }
    @Test(expected = IllegalArgumentException::class) fun rejectsArbitrarySkip() { PodcastPosition.skip(0, 60000, 1) }
}
