package com.soundsible.android

import android.os.Handler

/** One player-looper retry sequence; neither a failed handshake nor a stale owner can loop forever. */
internal class LiveReconnect(private val postDelayed: (Runnable, Long) -> Unit,
    private val removeCallbacks: (Runnable) -> Unit, private val owns: () -> Boolean,
    private val retry: () -> Unit, private val exhausted: () -> Unit) {
    constructor(main: Handler, owns: () -> Boolean, retry: () -> Unit, exhausted: () -> Unit) :
        this({ task, delay -> main.postDelayed(task, delay); Unit }, main::removeCallbacks, owns, retry, exhausted)
    private var active = false
    private var scheduled = false
    private var attempts = 0
    private val deadline = Runnable { if (active && owns()) { cancel(); exhausted() } }
    private val attempt = Runnable {
        if (!scheduled) return@Runnable
        scheduled = false
        if (active && owns()) { attempts++; retry() }
    }
    fun lost() {
        if (!owns() || scheduled) return
        if (!active) { active = true; attempts = 0; postDelayed(deadline, 30000) }
        if (attempts >= 3) { cancel(); exhausted(); return }
        scheduled = true; postDelayed(attempt, longArrayOf(1000, 2000, 4000)[attempts])
    }
    /** Let the recovered peer prove media health without a queued restart tearing it down. */
    fun transportConnected() {
        scheduled = false
        removeCallbacks(attempt)
    }
    fun connected() = cancel()
    fun cancel() {
        active = false; scheduled = false; attempts = 0
        removeCallbacks(attempt); removeCallbacks(deadline)
    }
}
