package com.soundsible.android

import java.util.ArrayDeque

/** Maps hardware output to one deck, preserving its frozen position through inactive gaps. */
internal class ProgramDeckClock {
    private data class Span(val start: Long, var end: Long, val source: Long)
    private val spans = ArrayDeque<Span>()
    var supplied = 0L
        private set
    fun reserve(outputStart: Long, count: Int) {
        require(outputStart >= 0 && count > 0)
        val previous = spans.peekLast()
        require(previous == null || outputStart >= previous.end)
        if (previous?.end == outputStart) previous.end += count
        else {
            check(spans.size < 64) { "Deck clock exceeded bounded output history" }
            spans.add(Span(outputStart, outputStart + count, supplied))
        }
        supplied += count
    }
    fun played(outputFrame: Long): Long {
        while (spans.size > 1 && spans.elementAt(1).start <= outputFrame) spans.removeFirst()
        val span = spans.peekFirst() ?: return 0L
        return (span.source + (outputFrame - span.start).coerceIn(0, span.end - span.start)).coerceIn(0, supplied)
    }
    fun reset() { spans.clear(); supplied = 0L }
}
