package com.soundsible.android

/** Heartbeat-driven retries. Only the owning uncommitted session calls begin. */
internal class ProgramDjRefineRetry {
    private var pair = ""
    private var inFlight = false
    private var measured = false
    private var nextAt = 0L
    fun begin(identity: String, now: Long): Boolean {
        if (identity != pair) { clear(); pair = identity }
        if (inFlight || measured || now < nextAt) return false
        inFlight = true; nextAt = now + 2000
        return true
    }
    fun finish(identity: String, ready: Boolean) {
        if (identity != pair) return
        inFlight = false; measured = ready
    }
    fun clear() { pair = ""; inFlight = false; measured = false; nextAt = 0 }
}
