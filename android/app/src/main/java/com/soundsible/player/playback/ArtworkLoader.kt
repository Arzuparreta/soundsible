package com.soundsible.player.playback

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Authenticated artwork fetch for surfaces outside the page (widget).
 * Covers require the paired-device Bearer token; the loader caps decoded
 * size so bitmaps stay well under the RemoteViews binder budget.
 */
object ArtworkLoader {
    fun fetch(url: String, token: String?, maxPx: Int = 256): Bitmap? {
        return try {
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                if (token != null) setRequestProperty("Authorization", "Bearer $token")
                connectTimeout = 8_000
                readTimeout = 8_000
            }
            try {
                if (conn.responseCode !in 200..299) return null
                val bytes = conn.inputStream.use { input ->
                    val out = ByteArrayOutputStream()
                    input.copyTo(out)
                    out.toByteArray()
                }
                if (bytes.isEmpty()) return null
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                var sample = 1
                while (bounds.outWidth / sample > maxPx || bounds.outHeight / sample > maxPx) {
                    sample *= 2
                }
                BitmapFactory.decodeByteArray(
                    bytes, 0, bytes.size,
                    BitmapFactory.Options().apply { inSampleSize = sample },
                )
            } finally {
                conn.disconnect()
            }
        } catch (_: Exception) {
            null
        }
    }
}
