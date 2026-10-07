package com.soundsible.android

import android.os.Looper
import androidx.media3.common.ForwardingSimpleBasePlayer
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi

/** Stable MediaSession identity while the service owns the underlying programme. */
@UnstableApi
internal class ProgramPlayerRouter(initial: Player) : ForwardingSimpleBasePlayer(initial) {
    private var closed = false

    /** The caller stops the old output first and releases the returned backend after switching. */
    fun replaceBackend(next: Player): Player {
        check(Looper.myLooper() == applicationLooper && !closed)
        val previous = player
        require(next !== previous && next.applicationLooper == applicationLooper)
        check(!previous.playWhenReady && previous.playbackState == Player.STATE_IDLE) {
            "Stop the previous programme before replacing its backend"
        }
        check(!next.playWhenReady) { "Prepare the next backend without starting its output" }
        setPlayer(next)
        return previous
    }

    override fun handleRelease(): com.google.common.util.concurrent.ListenableFuture<*> {
        closed = true
        return super.handleRelease()
    }
}
