package com.soundsible.android

/** Reopening a stalled occurrence must advance beyond its already consumed prefix. */
internal class ProgramDjRetryProgress {
    private var stalled: Pair<String, Long>? = null
    fun stalled(key: String, bufferedUs: Long) { stalled = key to bufferedUs.coerceAtLeast(0) }
    fun ready(key: String, bufferedUs: Long): Boolean {
        val previous = stalled ?: return true
        if (previous.first == key && bufferedUs <= previous.second) return false
        stalled = null
        return true
    }
    fun clear() { stalled = null }
}
