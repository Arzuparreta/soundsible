package com.soundsible.android

import android.os.Handler

/** One player-looper retry sequence; neither a failed handshake nor a stale owner can loop forever. */
internal class LiveReconnect(private val main: Handler, private val owns: () -> Boolean,
    private val retry: () -> Unit, private val exhausted: () -> Unit) {
    private var active = false
    private var scheduled = false
    private var attempts = 0
    private val deadline = Runnable { if (active && owns()) { cancel(); exhausted() } }
    private val attempt = Runnable {
        scheduled = false
        if (active && owns()) { attempts++; retry() }
    }
    fun lost() {
        if (!owns() || scheduled) return
        if (!active) { active = true; attempts = 0; main.postDelayed(deadline, 30000) }
        if (attempts >= 3) { cancel(); exhausted(); return }
        scheduled = true; main.postDelayed(attempt, longArrayOf(1000, 2000, 4000)[attempts])
    }
    fun connected() = cancel()
    fun cancel() {
        active = false; scheduled = false; attempts = 0
        main.removeCallbacks(attempt); main.removeCallbacks(deadline)
    }
}
