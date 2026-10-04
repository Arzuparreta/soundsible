package com.soundsible.player

import com.soundsible.player.data.parseJsonObject
import org.junit.Assert.*
import org.junit.Test

class JsonTest {
    @Test fun parsesObjectsArraysAndScalars() {
        val o = parseJsonObject(
            """{"s":"hi","i":3,"f":1.5,"b":true,"n":null,"a":[1,"x"],"o":{"k":"v"}}""",
        )
        assertEquals("hi", o.optString("s"))
        assertEquals(3, o.optInt("i"))
        assertEquals(1.5, o.optDouble("f")!!, 0.0)
        assertTrue(o.optBoolean("b"))
        assertTrue(o.isNull("n"))
        assertEquals(2, o.optArray("a")!!.length)
        assertEquals("v", o.optObject("o")!!.optString("k"))
    }

    @Test fun handlesEscapesAndEmptyContainers() {
        val o = parseJsonObject("""{"q":"a\"b\\c\nd","e":{},"l":[]}""")
        assertEquals("a\"b\\c\nd", o.optString("q"))
        assertEquals(0, o.optObject("e")!!.map.size)
        assertEquals(0, o.optArray("l")!!.length)
    }

    @Test fun rejectsMalformedInput() {
        for (bad in listOf("", "{", """{"a":}""", """{"a":1""", "[1]", """"str"""")) {
            try {
                parseJsonObject(bad)
                fail("Should reject: $bad")
            } catch (_: Exception) {
                // expected
            }
        }
    }

    @Test fun roundTripsBuilderOutput() {
        val o = parseJsonObject(
            com.soundsible.player.data.JsonObject.builder()
                .put("code", "AB12")
                .put("n", 7L)
                .build()
                .toJsonString(),
        )
        assertEquals("AB12", o.optString("code"))
        assertEquals(7, o.optInt("n"))
    }
}
