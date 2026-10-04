package com.soundsible.player.data

/**
 * What the QR code on the Soundsible pairing sheet actually contains.
 *
 * The engine builds it in `_pairing_connect_payload` and encodes it as compact
 * JSON in `qr_text`. Parsing is defensive because a camera will happily hand us
 * any barcode on the table. Mirrors `PairingPayload` in ios/SoundsibleKit.
 */
data class PairingPayload(
    val code: String,
    val claimUrl: String?,
    val playerUrl: String?,
) {
    /**
     * The server root implied by the payload. `claim_url` is the engine's own
     * best guess at a reachable base URL, so it is preferred; `player_url` is
     * the fallback for older engines.
     */
    fun baseUrl(): String? {
        claimUrl?.let { return trimSuffix(it, "/api/pairing/sessions/claim") }
        playerUrl?.let { return trimSuffix(it, "/player/") }
        return null
    }

    companion object {
        private fun trimSuffix(url: String, suffix: String): String? {
            if (url.endsWith(suffix)) {
                return url.dropLast(suffix.length).trimEnd('/').ifEmpty { null }
            }
            // Unknown shape: fall back to the origin so an absolute URL never
            // becomes a broken relative one.
            return try {
                val uri = java.net.URI(url)
                if (uri.scheme != null && uri.host != null) {
                    val port = if (uri.port != -1) ":${uri.port}" else ""
                    "${uri.scheme}://${uri.host}$port"
                } else {
                    url
                }
            } catch (_: Exception) {
                url
            }
        }

        /** Decode a scanned string, or return `null` if it is not Soundsible. */
        fun parse(scanned: String): PairingPayload? {
            val raw = try {
                parseJsonObject(scanned)
            } catch (_: Exception) {
                return null
            }
            if (raw.optString("type", "") != "soundsible_pairing") return null
            val code = raw.optString("code", "").trim()
            if (code.isEmpty()) return null
            return PairingPayload(
                code = code,
                claimUrl = raw.optString("claim_url", "").ifEmpty { null },
                playerUrl = raw.optString("player_url", "").ifEmpty { null },
            )
        }
    }
}
