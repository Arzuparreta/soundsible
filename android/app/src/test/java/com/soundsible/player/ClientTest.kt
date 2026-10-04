package com.soundsible.player

import com.soundsible.player.data.ServerConnection
import com.soundsible.player.data.parseJsonObject
import com.soundsible.player.net.HttpResponse
import com.soundsible.player.net.HttpTransport
import com.soundsible.player.net.PairingCoordinator
import com.soundsible.player.net.PairingOutcome
import com.soundsible.player.net.SoundsibleClient
import com.soundsible.player.net.SoundsibleError
import com.soundsible.player.store.InMemoryTokenStore
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

private class FakeTransport(val responses: ArrayDeque<HttpResponse>) : HttpTransport {
    val requests = mutableListOf<Triple<String, String, String?>>()
    override suspend fun send(method: String, url: String, headers: Map<String, String>, body: String?): HttpResponse {
        requests += Triple(method, url, body)
        return responses.removeFirst()
    }
}

class ClientTest {
    private val base = "http://192.168.1.40:5005"

    @Test fun autoConfirmedClaimStoresTheCredential() = runTest {
        val transport = FakeTransport(ArrayDeque(listOf(HttpResponse(201, """{"token":"paired-token"}"""))))
        val store = InMemoryTokenStore()
        val coordinator = PairingCoordinator(SoundsibleClient(transport, store), store)
        val outcome = coordinator.pair(base, "ab12cd34", "Pixel")
        assertTrue(outcome is PairingOutcome.Paired)
        assertEquals("paired-token", (outcome as PairingOutcome.Paired).connection.token)
        assertEquals("paired-token", store.load()?.token)
    }

    @Test fun codeIsUppercasedBeforeItIsSent() = runTest {
        val transport = FakeTransport(ArrayDeque(listOf(HttpResponse(201, """{"token":"t"}"""))))
        val store = InMemoryTokenStore()
        val coordinator = PairingCoordinator(SoundsibleClient(transport, store), store)
        coordinator.pair(base, "ab12cd34", "Pixel")
        val body = parseJsonObject(transport.requests[0].third!!)
        assertEquals("AB12CD34", body.optString("code"))
        assertEquals("android", body.optString("device_type"))
    }

    @Test fun claimWithoutTokenReportsOwnerConfirmation() = runTest {
        val transport = FakeTransport(ArrayDeque(listOf(HttpResponse(200, """{"id":"sess-1","status":"claimed"}"""))))
        val store = InMemoryTokenStore()
        val coordinator = PairingCoordinator(SoundsibleClient(transport, store), store)
        val outcome = coordinator.pair(base, "AB12", "Pixel")
        assertEquals(PairingOutcome.AwaitingOwnerConfirmation, outcome)
        assertNull(store.load())
    }

    @Test fun expiredCodeSurfacesTheServerMessage() = runTest {
        val transport = FakeTransport(ArrayDeque(listOf(HttpResponse(404, """{"error":"Invalid or expired pairing code"}"""))))
        val store = InMemoryTokenStore()
        val coordinator = PairingCoordinator(SoundsibleClient(transport, store), store)
        try {
            coordinator.pair(base, "NOPE", "Pixel")
            fail("An expired code must not pair")
        } catch (e: SoundsibleError.Http) {
            assertEquals(404, e.status)
            assertEquals("Invalid or expired pairing code", e.serverMessage)
        }
    }

    @Test fun manualPairingVerifiesBeforeItCommits() = runTest {
        val transport = FakeTransport(ArrayDeque(listOf(HttpResponse(200, """{"valid":true}"""))))
        val store = InMemoryTokenStore()
        val coordinator = PairingCoordinator(SoundsibleClient(transport, store), store)
        val outcome = coordinator.pairManually(base, "typed-token")
        assertTrue(outcome is PairingOutcome.Paired)
        assertEquals("typed-token", store.load()?.token)
        assertTrue(transport.requests[0].second.endsWith("/api/pairing/verify"))
    }

    @Test fun rejectedManualTokenLeavesTheStoreUntouched() = runTest {
        val transport = FakeTransport(ArrayDeque(listOf(HttpResponse(403, """{"error":"nope"}"""))))
        val store = InMemoryTokenStore(ServerConnection(base, "still-good"))
        val coordinator = PairingCoordinator(SoundsibleClient(transport, store), store)
        try {
            coordinator.pairManually(base, "typo")
            fail("A rejected token must not pair")
        } catch (e: SoundsibleError.Unauthorized) {
            assertEquals("still-good", store.load()?.token)
        }
    }

    @Test fun homeDecodesTheCarTree() = runTest {
        val body = """{"id":"home","title":"Home","items":[{"id":"t1","kind":"track","title":"Song","artist":"Artist","is_playable":true,"stream_url":"/api/static/stream/t1"}]}"""
        val transport = FakeTransport(ArrayDeque(listOf(HttpResponse(200, body))))
        val store = InMemoryTokenStore(ServerConnection(base, "t"))
        val response = SoundsibleClient(transport, store).home()
        assertEquals(1, response.items.size)
        assertEquals("Song", response.items[0].title)
        assertEquals("/api/static/stream/t1", response.items[0].streamUrl)
    }
}
