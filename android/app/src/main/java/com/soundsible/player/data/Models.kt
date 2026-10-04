package com.soundsible.player.data

/**
 * One row of the car browse tree.
 *
 * The engine returns exactly this shape for every node -- collection or track --
 * from `/api/car/home` and `/api/car/items/<id>`. See `shared/api/routes/car.py`.
 * Mirrors `CarItem` in ios/SoundsibleKit.
 */
data class CarItem(
    val id: String,
    val kind: String = "track",
    val trackId: String? = null,
    val title: String = "Untitled",
    val subtitle: String = "",
    val artist: String = "",
    val album: String = "",
    val durationSec: Int? = null,
    val artworkUrl: String? = null,
    val streamUrl: String? = null,
    val isBrowsable: Boolean = false,
    val isPlayable: Boolean = false,
) {
    /** Effective track id: explicit `track_id`, or the item id for track rows. */
    fun effectiveTrackId(): String? = trackId ?: if (kind == "track") id else null

    companion object {
        fun fromJson(o: JsonObject): CarItem = CarItem(
            id = o.optString("id", ""),
            kind = o.optString("kind", "track").ifEmpty { "track" },
            trackId = o.optString("track_id", "").ifEmpty { null },
            title = o.optString("title", "Untitled").ifEmpty { "Untitled" },
            subtitle = o.optString("subtitle", ""),
            artist = o.optString("artist", ""),
            album = o.optString("album", ""),
            durationSec = if (o.isNull("duration_sec")) null else o.optInt("duration_sec"),
            artworkUrl = o.optString("artwork_url", "").ifEmpty { null },
            streamUrl = o.optString("stream_url", "").ifEmpty { null },
            isBrowsable = o.optBoolean("is_browsable", false),
            isPlayable = o.optBoolean("is_playable", false),
        )
    }
}

data class RemotePlaybackState(
    val trackId: String? = null,
    val positionSec: Double? = null,
    val isPlaying: Boolean? = null,
    val deviceId: String? = null,
) {
    fun toJsonString(): String = JsonObject.builder().apply {
        trackId?.let { put("track_id", it) }
        positionSec?.let { put("position_sec", it) }
        isPlaying?.let { put("is_playing", it) }
        deviceId?.let { put("device_id", it) }
    }.build().toJsonString()
}

data class CarItemsResponse(
    val id: String?,
    val title: String?,
    val items: List<CarItem>,
) {
    companion object {
        fun fromJson(o: JsonObject): CarItemsResponse {
            val items = o.optArray("items")?.items?.mapNotNull { (it as? JsonObject)?.let(CarItem::fromJson) }
                ?: emptyList()
            return CarItemsResponse(
                id = o.optString("id", "").ifEmpty { null },
                title = o.optString("title", "").ifEmpty { null },
                items = items,
            )
        }
    }
}

data class PairingClaim(
    val sessionId: String?,
    val status: String?,
    val token: String?,
)

data class DeviceRegistration(
    val deviceId: String,
    val deviceName: String,
    val deviceType: String = "android",
) {
    fun toJsonString(): String = JsonObject.builder()
        .put("device_id", deviceId)
        .put("device_name", deviceName)
        .put("device_type", deviceType)
        .build()
        .toJsonString()
}
