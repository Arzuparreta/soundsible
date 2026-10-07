package com.soundsible.android

import java.io.EOFException
import java.io.IOException

/** One fresh GET when a pooled socket vanished before any response headers. */
object AudioConnectionRepair {
    fun allowed(error: IOException, connected: Boolean, repaired: Boolean, cancelled: Boolean): Boolean =
        !connected && !repaired && !cancelled &&
            error.message?.startsWith("unexpected end of stream") == true &&
            generateSequence<Throwable>(error) { it.cause }.any { it is EOFException }
}
