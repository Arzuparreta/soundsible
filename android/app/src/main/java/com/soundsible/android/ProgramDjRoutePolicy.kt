package com.soundsible.android

/**
 * The DJ route rules both clients apply, kept identical to the web client's
 * `ui_web/src/lib/djRoute.ts`; both run `shared/contracts/dj_route_rules.json`.
 *
 * A route is the whole programme, history included. A block is a requested
 * song and the bridges planned in front of it; edits move, keep or drop a
 * block as one unit so a bridge never strands its owner.
 */
internal object ProgramDjRoutePolicy {
    data class RouteRow(val key: String, val kind: String, val owner: String? = null, val group: String? = null, val recording: String = key) {
        val bridgeOwner: String? get() = owner.takeIf { kind == "bridge" }
    }

    /** The first index nothing playing or committed depends on. */
    fun editableFrom(rows: List<RouteRow>, current: Int, floor: Int): Int {
        val protectedEnd = maxOf(current, floor)
        val live = rows.subList(maxOf(0, current).coerceAtMost(rows.size), (protectedEnd + 1).coerceIn(0, rows.size))
        val owners = live.mapNotNull { it.bridgeOwner }.toSet()
        val locked = live.map { it.key }.toSet()
        val last = rows.indices.lastOrNull { rows[it].key in locked || rows[it].key in owners || rows[it].bridgeOwner in owners } ?: -1
        return maxOf(protectedEnd, last) + 1
    }

    /** The keys of `target`'s block in route order, or null for an unknown row. */
    fun block(rows: List<RouteRow>, target: String): List<String>? {
        val row = rows.firstOrNull { it.key == target } ?: return null
        val parent = row.bridgeOwner ?: target
        return rows.filter { it.key == parent || it.bridgeOwner == parent }.map { it.key }
    }

    /** The route after moving `target`'s block in front of `before`'s block (the end when null), or null when not allowed. */
    fun moveBefore(rows: List<RouteRow>, target: String, before: String?, floor: Int): List<String>? {
        val row = rows.firstOrNull { it.key == target } ?: return null
        val parent = row.bridgeOwner ?: target
        val moving = block(rows, target)!!.toSet()
        if (parent !in moving || (before != null && before in moving)) return null
        val start = rows.indexOfFirst { it.key in moving }
        if (start <= floor) return null
        val rest = rows.filter { it.key !in moving }
        val anchor = before?.let { block(rows, it)?.firstOrNull() }
        val found = if (before == null) rest.size else rest.indexOfFirst { it.key == anchor }
        val at = maxOf(floor + 1, if (found == -1) rest.size else found)
        return rest.take(at).map { it.key } + rows.filter { it.key in moving }.map { it.key } + rest.drop(at).map { it.key }
    }

    /** A drag of `target`'s block onto row `destination`: in front of that row's block when moving up, after it when moving down. */
    fun moveToIndex(rows: List<RouteRow>, target: String, destination: Int, floor: Int): List<String>? {
        require(destination in rows.indices)
        val moving = block(rows, target)?.toSet() ?: return null
        if (rows[destination].key in moving) return null
        val neighbour = block(rows, rows[destination].key)!!
        val upward = destination < rows.indexOfFirst { it.key in moving }
        if (upward) return moveBefore(rows, target, neighbour.first(), floor)
        val rest = rows.filter { it.key !in moving }
        return moveBefore(rows, target, rest.getOrNull(rest.indexOfFirst { it.key == neighbour.last() } + 1)?.key, floor)
    }

    /** Where a request is queued at once: in front of `before`'s block when it is past the floor, otherwise right after the floor. */
    fun requestInsertion(rows: List<RouteRow>, floor: Int, before: String?): Int {
        if (before != null) {
            val anchor = block(rows, before)?.firstOrNull()
            val index = rows.indexOfFirst { it.key == anchor }
            if (anchor != null && index > floor) return index
        }
        return minOf(rows.size, floor + 1)
    }

    /** What removing one occurrence takes with it: the bridges that lead into it. Removing a bridge removes only that bridge. */
    fun removed(rows: List<RouteRow>, target: String): List<String> {
        if (rows.none { it.key == target }) return emptyList()
        return rows.filter { it.key == target || it.bridgeOwner == target }.map { it.key }
    }

    /** How many future rows a repair sends: `limit`, extended so no bridge inside it leaves without its request. */
    fun repairHorizon(future: List<RouteRow>, limit: Int): Int {
        var count = minOf(limit, future.size)
        future.take(count).mapNotNull { it.bridgeOwner }.forEach { owner ->
            count = maxOf(count, future.indexOfFirst { it.key == owner } + 1)
        }
        return count
    }

    /** The future rows a session change keeps: single requests other than the new lead recording, with their bridges. */
    fun sessionSurvivors(future: List<RouteRow>, lead: String?): List<String> {
        val wanted = future.filter { it.kind == "user" && it.group == null && (lead == null || it.recording != lead) }.map { it.key }.toSet()
        return future.filter { it.key in wanted || it.bridgeOwner in wanted }.map { it.key }
    }

    /**
     * The future a replan writes. Requests and their bridges keep their depth; generated rows fill
     * the other places in order, skipping recordings a kept row plays, and continue after the last
     * kept row. When the generated rows run out first, the kept rows close up in their order.
     */
    fun replan(previous: List<RouteRow>, generated: List<RouteRow>): List<String> {
        val requests = previous.filter { it.kind == "user" }.map { it.key }.toSet()
        val kept = previous.withIndex().filter { (_, row) -> row.kind == "user" || row.bridgeOwner in requests }
        val keptRecordings = kept.map { it.value.recording }.toSet()
        val filler = generated.filter { it.recording !in keptRecordings }
        val result = mutableListOf<String>()
        var next = 0
        for ((index, row) in kept) {
            while (result.size < index && next < filler.size) result.add(filler[next++].key)
            result.add(row.key)
        }
        while (next < filler.size) result.add(filler[next++].key)
        return result
    }
}
