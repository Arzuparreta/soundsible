package com.soundsible.android

/** Replanning replaces filler while preserving explicit occurrences at their chosen depth. */
internal object ProgramDjRoutePolicy {
    fun <T> retainPins(previous: List<T>, proposed: List<T>, pinned: (T) -> Boolean, identity: (T) -> String): List<T> {
        val anchors = previous.withIndex().filter { pinned(it.value) }.associate { it.index to it.value }
        if (anchors.isEmpty()) return proposed
        val anchorIds = anchors.values.map(identity).toSet()
        val filler = proposed.filter { identity(it) !in anchorIds }
        val size = filler.size + anchors.size
        require(anchors.keys.all { it < size }) { "Not enough replacement music to preserve requested positions" }
        var next = 0
        return (0 until size).map { index -> anchors[index] ?: filler[next++] }
    }
}
