package com.soundsible.android

import android.content.Context
import org.webrtc.AudioTrackSink

/**
 * A relay reader started the way the listener's player starts one: MediaMTX
 * answers a read with 404 until the publisher's media has reached it, which
 * can trail the publisher's own accepted offer. The player retries
 * (`LiveReconnect`); a test reading the relay retries the same way instead of
 * racing it. Any other failure, or a 404 that outlasts the window, fails.
 */
internal fun startLiveReader(context: Context, connection: EngineConnection, whep: String, sink: AudioTrackSink, windowMs: Long = 20000): LivePeer {
    val until = System.nanoTime() + windowMs * 1_000_000
    while (true) {
        val reader = LivePeer(context, connection, whep, null, false, {}, sink)
        try {
            reader.start()
            return reader
        } catch (failure: IllegalStateException) {
            if (failure.message != "LIVE_OFFER_404" || System.nanoTime() > until) throw failure
            Thread.sleep(250)
        }
    }
}
