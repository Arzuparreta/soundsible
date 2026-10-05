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
    /** Approximate dominant color of [bitmap], darkened for a backdrop. */
    fun dominantColor(bitmap: Bitmap): Int {
        return try {
            val thumb = Bitmap.createScaledBitmap(bitmap, 8, 8, true)
            var r = 0
            var g = 0
            var b = 0
            var n = 0
            for (x in 0 until 8) {
                for (y in 0 until 8) {
                    val pixel = thumb.getPixel(x, y)
                    if (android.graphics.Color.alpha(pixel) < 128) continue
                    r += android.graphics.Color.red(pixel)
                    g += android.graphics.Color.green(pixel)
                    b += android.graphics.Color.blue(pixel)
                    n++
                }
            }
            thumb.recycle()
            if (n == 0) return 0xFF000000.toInt()
            // Darken toward black so white type always reads.
            android.graphics.Color.rgb(r / n / 2, g / n / 2, b / n / 2)
        } catch (_: Exception) {
            0xFF000000.toInt()
        }
    }

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
