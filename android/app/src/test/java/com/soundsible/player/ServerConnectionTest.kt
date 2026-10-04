package com.soundsible.player

import com.soundsible.player.data.ServerConnection
import org.junit.Assert.*
import org.junit.Test

class ServerConnectionTest {
    private val connection = ServerConnection("http://192.168.1.40:5005", "token")

    @Test fun resolvesRelativePathsAgainstTheServer() {
        assertEquals(
            "http://192.168.1.40:5005/api/static/stream/abc",
            connection.resolve("/api/static/stream/abc"),
        )
    }

    @Test fun passesAbsoluteUrlsThrough() {
        val absolute = "https://relay.example.com/api/static/stream/abc"
        assertEquals(absolute, connection.resolve(absolute))
    }

    @Test fun baseUrlTrailingSlashDoesNotDoubleUp() {
        val c = ServerConnection("http://192.168.1.40:5005/", "token")
        assertEquals("http://192.168.1.40:5005/api/car/home", c.resolve("/api/car/home"))
    }

    @Test fun roundTripsThroughJson() {
        val restored = ServerConnection.parse(connection.toJsonString())
        assertEquals(connection, restored)
    }
}
