package com.soundsible.android

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test

@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
class LivePeerPolicyTest {
    @Test fun reverseProxyLocationRetainsExactlyOneMediaPrefix() {
        val endpoint = "https://relay.example/media/live/whip".toHttpUrl()
        assertEquals("https://relay.example/media/live/whip/resource", LivePeer.location(endpoint, "/live/whip/resource").toString())
        assertEquals("https://relay.example/media/live/whip/resource", LivePeer.location(endpoint, "/media/live/whip/resource").toString())
        assertEquals("https://relay.example/media/live/resource", LivePeer.location(endpoint, "resource").toString())
    }
    @Test fun resourceCannotRedirectCredentialsOrDowngradeOrigin() {
        val endpoint = "https://relay.example/live/whip".toHttpUrl()
        for (value in listOf("http://relay.example/resource", "https://other.example/resource", "https://user:secret@relay.example/resource", "/resource#fragment")) {
            assertTrue(value, runCatching { LivePeer.location(endpoint, value) }.isFailure)
        }
    }
}
