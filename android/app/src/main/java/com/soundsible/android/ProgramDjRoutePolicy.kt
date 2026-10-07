package com.soundsible.android

/** Replanning replaces filler while preserving explicit occurrences at their chosen depth. */
internal object ProgramDjRoutePolicy {
    fun <T> block(rows: List<T>, target: String, key: (T) -> String, owner: (T) -> String?): List<T> {
        val row = rows.firstOrNull { key(it) == target } ?: error("Unknown occurrence")
        val parent = owner(row) ?: target
        return rows.filter { key(it) == parent || owner(it) == parent }
    }
    fun <T> moveBlock(rows: List<T>, target: String, destination: Int, key: (T) -> String, owner: (T) -> String?): List<T> {
        require(destination in rows.indices)
        val moving = block(rows, target, key, owner)
        val keys = moving.map(key).toSet()
        if (key(rows[destination]) in keys) return rows
        val neighbour = block(rows, key(rows[destination]), key, owner)
        val upward = destination < rows.indexOfFirst { key(it) in keys }
        val remaining = rows.filter { key(it) !in keys }
        val edge = if (upward) key(neighbour.first()) else key(neighbour.last())
        val insertion = remaining.indexOfFirst { key(it) == edge } + if (upward) 0 else 1
        return remaining.take(insertion) + moving + remaining.drop(insertion)
    }
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
