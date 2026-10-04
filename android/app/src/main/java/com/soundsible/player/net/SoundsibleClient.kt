package com.soundsible.player.net

import com.soundsible.player.data.CarItem
import com.soundsible.player.data.CarItemsResponse
import com.soundsible.player.data.DeviceRegistration
import com.soundsible.player.data.JsonObject
import com.soundsible.player.data.PairingClaim
import com.soundsible.player.data.RemotePlaybackState
import com.soundsible.player.data.ServerConnection
import com.soundsible.player.data.parseJsonObject
import com.soundsible.player.store.TokenStore
import java.net.URLEncoder

/**
 * Everything the phone asks of a Soundsible engine.
 *
 * Deliberately thin: the engine already ranks, plans and resolves, so this
 * type carries requests and decodes answers and holds no opinion about what
 * the library means. Mirrors `SoundsibleClient` in ios/SoundsibleKit.
 */
class SoundsibleClient(
    private val transport: HttpTransport,
    private val tokenStore: TokenStore,
) {
    val connection: ServerConnection? get() = tokenStore.load()

    suspend fun home(): CarItemsResponse = get("/api/car/home") { CarItemsResponse.fromJson(it) }

    /**
     * Children of one browse node. The id can carry separators
     * (`playlist:Road Trip`), so it is percent-encoded as a single path
     * segment rather than passed through raw.
     */
    suspend fun items(itemId: String): CarItemsResponse {
        val encoded = URLEncoder.encode(itemId, "UTF-8").replace("+", "%20")
        return get("/api/car/items/$encoded") { CarItemsResponse.fromJson(it) }
    }

    suspend fun registerDevice(registration: DeviceRegistration): Boolean {
        send("POST", "/api/devices/register", registration.toJsonString())
        return true
    }

    suspend fun publishPlaybackState(state: RemotePlaybackState): Boolean {
        send("PUT", "/api/playback/state", state.toJsonString())
        return true
    }

    /** Confirm the stored credential is still good. */
    suspend fun verifyPairing(): Boolean {
        val (status) = authed("GET", "/api/pairing/verify", null)
        return status == 200
    }

    /**
     * Claim a visible pairing code. When the owner has the QR sheet open with
     * auto-confirm on, the engine answers 201 with the token and pairing is
     * done. Otherwise it answers 200 and the session waits for the owner -- a
     * state this app cannot resolve, because the plaintext token is handed to
     * whoever confirms and is never stored.
     */
    suspend fun claimPairingCode(baseUrl: String, code: String, deviceName: String): PairingClaim {
        val root = baseUrl.trimEnd('/')
        val body = JsonObject.builder()
            .put("code", code.uppercase())
            .put("device_name", deviceName)
            .put("device_type", "android")
            .build()
            .toJsonString()
        val response = transport.send(
            "POST",
            "$root/api/pairing/sessions/claim",
            mapOf("Content-Type" to "application/json"),
            body,
        )
        throwIfFailed(response)
        val json = try {
            parseJsonObject(response.body)
        } catch (e: Exception) {
            throw SoundsibleError.Decoding(e.message ?: "claim response")
        }
        return PairingClaim(
            sessionId = json.optString("id", "").ifEmpty { json.optString("session_id", "").ifEmpty { null } },
            status = json.optString("status", "").ifEmpty { null },
            token = json.optString("token", "").ifEmpty { null },
        )
    }

    // -- Plumbing ----------------------------------------------------------

    private suspend fun <T> get(path: String, decode: (JsonObject) -> T): T {
        val (_, body) = authed("GET", path, null)
        return decodeBody(body, decode)
    }

    private suspend fun send(method: String, path: String, body: String?) {
        authed(method, path, body)
    }

    private suspend fun authed(method: String, path: String, body: String?): Pair<Int, String> {
        val connection = tokenStore.load() ?: throw SoundsibleError.NotConfigured
        val headers = mutableMapOf("Authorization" to "Bearer ${connection.token}")
        if (body != null) headers["Content-Type"] = "application/json"
        val response = try {
            transport.send(method, connection.resolve(path), headers, body)
        } catch (e: SoundsibleError) {
            throw e
        } catch (e: Exception) {
            throw SoundsibleError.Transport(e.message ?: e.javaClass.simpleName)
        }
        throwIfFailed(response)
        return response.status to response.body
    }

    private fun <T> decodeBody(body: String, decode: (JsonObject) -> T): T {
        return try {
            decode(parseJsonObject(body))
        } catch (e: SoundsibleError) {
            throw e
        } catch (e: Exception) {
            throw SoundsibleError.Decoding(e.message ?: "response body")
        }
    }

    private fun throwIfFailed(response: HttpResponse) {
        if (response.status in 200..299) return
        if (response.status == 401 || response.status == 403) throw SoundsibleError.Unauthorized
        val message = try {
            parseJsonObject(response.body).optString("error", "")
        } catch (_: Exception) {
            ""
        }
        throw SoundsibleError.Http(response.status, message)
    }

    /** Items of one collection that are playable, for queueing whole screens. */
    suspend fun playableItems(itemId: String): List<CarItem> = items(itemId).items.filter { it.isPlayable }
}
