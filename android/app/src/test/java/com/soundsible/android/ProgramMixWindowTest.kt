package com.soundsible.android

import org.junit.Assert.*
import org.junit.Test

class ProgramMixWindowTest {
    @Test fun hardwareDominanceLagsReservedBuffersUntilTheMidpoint() {
        val window = ProgramMixWindow(48000, 96000, 0, 1, 4)
        // Render may already have promoted input1 at frame144000; the device is still earlier.
        assertEquals(0, window.dominant(47999))
        assertEquals(0, window.dominant(95999))
        assertEquals(1, window.dominant(96000))
        assertEquals(1, window.dominant(200000))
    }
    @Test fun directCutAndReverseDirectionUseTheActualSwitchFrame() {
        val window = ProgramMixWindow(1200, 0, 1, 0, 7)
        assertEquals(1, window.dominant(1199))
        assertEquals(0, window.dominant(1200))
        assertEquals(0, window.dominant(3000))
    }
}
