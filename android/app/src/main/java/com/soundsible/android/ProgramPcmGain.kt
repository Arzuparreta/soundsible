package com.soundsible.android

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.roundToInt

/** Integer PCM after Media3's format conversion; one envelope per decoded stream. */
internal class ProgramPcmGain {
    private var gain = 1.0
    private var target = 1.0
    private var step = 0.0
    private var remaining = 0
    fun reset(value: Double = 1.0) {
        gain = valid(value); target = gain; step = 0.0; remaining = 0
    }
    private fun valid(value: Double) = value.takeIf { it.isFinite() && it in 0.05..4.0 } ?: 1.0
    fun process(input: ByteBuffer, output: ByteBuffer, value: Double, sampleRate: Int, channels: Int) {
        require(sampleRate > 0 && channels in 1..32 && input.remaining() % (channels * 2) == 0 && output.remaining() >= input.remaining())
        input.order(ByteOrder.LITTLE_ENDIAN); output.order(ByteOrder.LITTLE_ENDIAN)
        val next = valid(value)
        if (next != target) {
            target = next; remaining = (sampleRate / 100).coerceAtLeast(1); step = (target - gain) / remaining
        }
        while (input.hasRemaining()) {
            if (remaining > 0) { gain += step; if (--remaining == 0) gain = target }
            repeat(channels) {
                val sample = input.short.toInt()
                output.putShort((sample * gain).roundToInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort())
            }
        }
    }
}
