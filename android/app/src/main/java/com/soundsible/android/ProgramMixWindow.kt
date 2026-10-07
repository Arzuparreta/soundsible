package com.soundsible.android

/** Metadata follows hardware playout, independently of the decoder/render cursor. */
internal data class ProgramMixWindow(val start: Long, val length: Long,
    val outgoing: Int, val incoming: Int, val epoch: Long) {
    init { require(start >= 0 && length >= 0 && outgoing in 0..1 && incoming == 1 - outgoing && epoch >= 0) }
    fun dominant(played: Long): Int =
        if (played < start || length > 0 && played - start < length / 2) outgoing else incoming
}
