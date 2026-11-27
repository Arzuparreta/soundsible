package com.soundsible.android

import org.json.JSONArray

/** Stage overflow in the app process, leaving each MediaSession payload bounded. */
internal object ProgramQueueWindow {
    const val MAX_ROWS = 1000
    const val MAX_BYTES = 256 * 1024
    private const val PAGE_BYTES = 128 * 1024
    private const val PAGE_ROWS = 250

    data class Opening(val rows: String, val index: Int, val remaining: ArrayDeque<String>)

    fun split(rows: JSONArray, selected: Int, shuffle: Boolean): Opening {
        require(selected in 0 until rows.length())
        if (rows.length() <= MAX_ROWS) {
            val json = rows.toString()
            if (json.toByteArray(Charsets.UTF_8).size <= MAX_BYTES) return Opening(json, selected, ArrayDeque())
        }

        // Keep immediate history and continue from the exact selected occurrence.
        val history = if (shuffle) emptyList() else (maxOf(0, selected - 16) until selected).toList().asReversed()
        val opening = ArrayDeque<String>()
        val current = rows.getJSONObject(selected).toString()
        opening.add(current)
        var bytes = 2 + current.toByteArray(Charsets.UTF_8).size
        require(bytes <= PAGE_BYTES)
        for (i in history) {
            val row = rows.getJSONObject(i).toString()
            val cost = row.toByteArray(Charsets.UTF_8).size + 1
            if (bytes + cost > PAGE_BYTES / 2) break
            opening.addFirst(row)
            bytes += cost
        }
        val index = opening.size - 1
        val following = if (shuffle) (0 until rows.length()).filter { it != selected }.shuffled()
            else (selected + 1 until rows.length())
        val pages = ArrayDeque<String>()
        var page = opening
        for (i in following) {
            val row = rows.getJSONObject(i).toString()
            val cost = row.toByteArray(Charsets.UTF_8).size + 1
            require(cost + 1 <= PAGE_BYTES)
            if (page.size >= PAGE_ROWS || bytes + cost > PAGE_BYTES) {
                pages.add(page.joinToString(",", "[", "]"))
                page = ArrayDeque()
                bytes = 2
            }
            bytes += cost - if (page.isEmpty()) 1 else 0
            page.add(row)
        }
        pages.add(page.joinToString(",", "[", "]"))
        return Opening(pages.removeFirst(), index, pages)
    }

    // The plugin and service are in the same application process on the main looper.
    val staged = mutableMapOf<String, ArrayDeque<String>>()
}
