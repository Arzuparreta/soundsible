package com.soundsible.android

import okhttp3.MediaType
import okhttp3.RequestBody
import okio.BufferedSink
import java.io.IOException
import java.io.InputStream

/** One-shot bounded stream: no whole-file byte/base64 buffer and no replay after cancellation. */
class ImportStreamBody(
    private val open: () -> InputStream,
    private val current: () -> Boolean,
    private val size: Long,
    private val mime: MediaType?,
    private val observe: (InputStream?) -> Unit = {},
    private val maxBytes: Long = MAX_BYTES,
) : RequestBody() {
    companion object { const val MAX_BYTES = 100L * 1024 * 1024 }
    init { require(size in -1..maxBytes && maxBytes > 0) }
    override fun contentType(): MediaType? = mime
    override fun contentLength(): Long = size
    override fun isOneShot(): Boolean = true
    override fun writeTo(sink: BufferedSink) {
        fun checkCurrent() { if (!current()) throw IOException("IMPORT_CANCELLED") }
        checkCurrent()
        open().use { input ->
            observe(input)
            try {
                val chunk = ByteArray(64 * 1024)
                var total = 0L
                while (true) {
                    checkCurrent()
                    val count = input.read(chunk)
                    checkCurrent()
                    if (count < 0) break
                    if (count == 0) throw IOException("IMPORT_STALLED")
                    total += count
                    if (total > maxBytes || (size >= 0 && total > size)) throw IOException("IMPORT_TOO_LARGE")
                    sink.write(chunk, 0, count)
                }
                if (size >= 0 && total != size) throw IOException("IMPORT_SIZE_CHANGED")
            } finally { observe(null) }
        }
    }
}
