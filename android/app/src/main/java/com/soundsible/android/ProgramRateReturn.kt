package com.soundsible.android

import android.os.Handler
import android.os.Looper

/** Returns a deck to normal tempo using playout time, so programme pause holds the ramp. */
internal class ProgramRateReturn(private val main: Handler, private val owns: () -> Boolean,
    private val positionUs: () -> Long, private val applyRate: (Float) -> Unit) : AutoCloseable {
    private var tick: Runnable? = null
    private var serial = 0L
    fun start(rate: Float) {
        check(Looper.myLooper() == main.looper)
        require(rate.isFinite() && rate in 0.94f..1.06f)
        close()
        if (!owns()) return
        if (kotlin.math.abs(rate - 1f) < 0.001f) { applyRate(1f); return }
        val token = serial
        val started = positionUs()
        var progress = 0.0
        val task = object : Runnable {
            override fun run() {
                if (token != serial || !owns()) { if (token == serial) tick = null; return }
                progress = maxOf(progress, ((positionUs() - started).toDouble() / 8000000).coerceIn(0.0, 1.0))
                applyRate((rate + (1 - rate) * progress).toFloat())
                if (progress < 1.0) main.postDelayed(this, 200) else tick = null
            }
        }
        tick = task
        main.post(task)
    }
    override fun close() {
        check(Looper.myLooper() == main.looper)
        serial++
        tick?.let { main.removeCallbacks(it) }; tick = null
    }
}
