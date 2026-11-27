package com.soundsible.android

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ProgramQueueWindowTest {
    private fun rows(count: Int, title: String = "Title") = JSONArray().apply {
        repeat(count) { put(JSONObject().put("id", "duplicate").put("title", title).put("occurrence", it)) }
    }

    private fun occurrences(page: String) = JSONArray(page).let { rows ->
        (0 until rows.length()).map { rows.getJSONObject(it).getInt("occurrence") }
    }

    @Test fun fitsLeaveQueueAndIndexIntact() {
        val original = rows(40)
        val opening = ProgramQueueWindow.split(original, 31, false)
        assertEquals(original.toString(), opening.rows)
        assertEquals(31, opening.index)
        assertTrue(opening.remaining.isEmpty())
    }

    @Test fun firstMiddleAndLastOccurrencesContinueInOrder() {
        val original = rows(1001)
        for (selected in listOf(0, 501, 1000)) {
            val opening = ProgramQueueWindow.split(original, selected, false)
            val first = occurrences(opening.rows)
            assertEquals(selected, first[opening.index])
            val following = first.drop(opening.index) + opening.remaining.flatMap(::occurrences)
            assertEquals((selected..1000).toList(), following)
            assertTrue(opening.index <= 16)
        }
    }

    @Test fun pagesCountUtf8AndShuffleKeepsEveryOccurrence() {
        val original = rows(90, "雪".repeat(1500))
        assertTrue(original.toString().length < ProgramQueueWindow.MAX_BYTES)
        assertTrue(original.toString().toByteArray(Charsets.UTF_8).size > ProgramQueueWindow.MAX_BYTES)
        val opening = ProgramQueueWindow.split(original, 67, true)
        assertEquals(0, opening.index)
        assertEquals(67, occurrences(opening.rows).first())
        assertTrue(opening.remaining.isNotEmpty())
        val pages = listOf(opening.rows) + opening.remaining
        assertTrue(pages.all { it.toByteArray(Charsets.UTF_8).size <= ProgramQueueWindow.MAX_BYTES })
        assertEquals((0 until 90).toList(), pages.flatMap(::occurrences).sorted())
    }
}
