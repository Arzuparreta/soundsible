package com.soundsible.android

/** Millisecond arithmetic shared by resume persistence and service-side seek. */
object PodcastPosition {
    fun bounded(position: Long, duration: Long): Long = position.coerceAtLeast(0).let { if (duration > 0) it.coerceAtMost(duration) else it }
    fun skip(position: Long, duration: Long, seconds: Int): Long {
        require(seconds == -15 || seconds == 15)
        val start = position.coerceAtLeast(0)
        val target = if (seconds > 0 && start > Long.MAX_VALUE - 15000) Long.MAX_VALUE else start + seconds * 1000L
        return bounded(target, duration)
    }
}
