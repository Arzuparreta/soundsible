package com.soundsible.player.data

/**
 * Where a Soundsible lives and how this device proves it is allowed in.
 * Mirrors `ServerConnection` in ios/SoundsibleKit.
 */
data class ServerConnection(
    val baseUrl: String,
    val token: String,
    val label: String = "Soundsible",
) {
    /**
     * Resolve a path the engine handed us against this server.
     *
     * The car contract returns *relative* URLs (`/api/static/stream/<id>`); an
     * absolute one would be wrong the moment the same library is reached over
     * Tailscale instead of the LAN. Absolute inputs pass through so a future
     * engine returning them does not break the app.
     */
    fun resolve(path: String): String {
        val trimmed = path.trim()
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed
        val base = baseUrl.trimEnd('/')
        val suffix = if (trimmed.startsWith("/")) trimmed else "/$trimmed"
        return base + suffix
    }

    fun toJsonString(): String = JsonObject.builder()
        .put("base_url", baseUrl)
        .put("token", token)
        .put("label", label)
        .build()
        .toJsonString()

    companion object {
        fun fromJson(o: JsonObject): ServerConnection = ServerConnection(
            baseUrl = o.optString("base_url", ""),
            token = o.optString("token", ""),
            label = o.optString("label", "Soundsible"),
        )

        fun parse(text: String): ServerConnection = fromJson(parseJsonObject(text))
    }
}
