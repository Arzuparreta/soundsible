package com.soundsible.player.playback

import com.soundsible.player.data.ServerConnection
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Downloads authenticated tracks into the app's files dir and deletes them on
 * unpin/evict. Policy (what to fetch, what to drop) lives in
 * [com.soundsible.player.logic.OfflineLibrary]; this only moves bytes.
 */
class OfflineStore(private val filesDir: File) {
    fun trackFile(trackId: String): File = File(File(filesDir, "offline"), "$trackId.audio")

    suspend fun download(connection: ServerConnection, streamPath: String, trackId: String): File =
        withContext(Dispatchers.IO) {
            val url = connection.resolve(streamPath)
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                setRequestProperty("Authorization", "Bearer ${connection.token}")
                connectTimeout = 15_000
                readTimeout = 60_000
            }
            try {
                if (conn.responseCode !in 200..299) throw IOException("HTTP ${conn.responseCode}")
                val out = trackFile(trackId)
                out.parentFile?.mkdirs()
                conn.inputStream.use { input ->
                    FileOutputStream(out).use { output -> input.copyTo(output) }
                }
                out
            } finally {
                conn.disconnect()
            }
        }

    fun delete(trackId: String): Boolean = trackFile(trackId).delete()

    class IOException(message: String) : Exception(message)
}
