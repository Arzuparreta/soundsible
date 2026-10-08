package com.soundsible.android

import org.json.JSONObject

/**
 * The record a queued song is on, and its place there: what Media3 shows on
 * the lock screen and in the car, and what a download of a streamed song files
 * it under. Read from a queue row; anything absent, malformed or out of range
 * is left unset rather than guessed.
 */
data class ProgramRelease(val albumArtist: String?, val trackNumber: Int?, val discNumber: Int?, val year: Int?) {
    /** Writes what is known into a queue row or a session track, and nothing else. */
    fun writeTo(row: JSONObject): JSONObject = row.apply {
        albumArtist?.let { put("album_artist", it) }
        trackNumber?.let { put("track_number", it) }
        discNumber?.let { put("disc_number", it) }
        year?.let { put("year", it) }
    }

    companion object {
        /** What a queued item already carries, through Media3's own fields. */
        fun of(metadata: androidx.media3.common.MediaMetadata) = ProgramRelease(
            metadata.albumArtist?.toString(), metadata.trackNumber, metadata.discNumber, metadata.releaseYear,
        )

        fun read(row: JSONObject): ProgramRelease {
            val albumArtist = if (row.has("album_artist") && !row.isNull("album_artist")) row.getString("album_artist") else null
            require(albumArtist == null || albumArtist.length <= 4096)
            return ProgramRelease(albumArtist, whole(row, "track_number", 1..999), whole(row, "disc_number", 1..99), whole(row, "year", 1000..9999))
        }

        private fun whole(row: JSONObject, name: String, range: IntRange): Int? {
            if (!row.has(name) || row.isNull(name)) return null
            val value = row.optDouble(name, Double.NaN)
            if (!value.isFinite() || value % 1.0 != 0.0) return null
            return value.toInt().takeIf { it in range }
        }
    }
}
