package com.soundsible.android

/** Receiver health from cumulative RTP packets, independent of audio content and ICE state.
 *
 * Call on one owner with a monotonic clock and reset for each new peer. HEALTHY means
 * sustained progress, so a short burst cannot repeatedly clear a reconnect budget.
 */
internal class LiveMediaHealth {
    enum class State { WAITING, HEALTHY, STALLED }

    private var startedAtMs: Long? = null
    private var previousPackets: Long? = null
    private var lastProgressAtMs: Long? = null
    private var growingSinceMs: Long? = null
    private var healthy = false
    private var active = true

    fun reset(nowMs: Long) {
        startedAtMs = nowMs
        previousPackets = null
        lastProgressAtMs = null
        growingSinceMs = null
        healthy = false
        active = true
    }

    fun observe(nowMs: Long, packetsReceived: Long, active: Boolean): State {
        if (!active) {
            reset(nowMs)
            this.active = false
            return State.WAITING
        }
        if (!this.active || startedAtMs == null) reset(nowMs)

        val previous = previousPackets
        previousPackets = packetsReceived
        when {
            previous == null -> Unit // A snapshot establishes a baseline, not progress.
            packetsReceived > previous -> {
                val lastProgress = lastProgressAtMs
                if (lastProgress != null && nowMs - lastProgress >= STALL_MS) healthy = false
                if (growingSinceMs == null || lastProgress == null || nowMs - lastProgress >= STALL_MS) {
                    growingSinceMs = nowMs
                }
                lastProgressAtMs = nowMs
                if (nowMs - growingSinceMs!! >= HEALTHY_MS) healthy = true
            }
            packetsReceived < previous -> {
                // Stats can replace/reset the receiver. Rebaseline without extending its
                // existing media deadline or treating the new absolute count as receipt.
                growingSinceMs = null
                healthy = false
            }
            else -> growingSinceMs = null
        }

        val lastProgress = lastProgressAtMs
        val stalled = if (lastProgress == null) {
            nowMs - startedAtMs!! >= INITIAL_GRACE_MS
        } else {
            nowMs - lastProgress >= STALL_MS
        }
        if (stalled) {
            growingSinceMs = null
            healthy = false
            return State.STALLED
        }
        return if (healthy) State.HEALTHY else State.WAITING
    }

    private companion object {
        const val INITIAL_GRACE_MS = 10_000L
        const val STALL_MS = 5_000L
        const val HEALTHY_MS = 5_000L
    }
}
