package com.soundsible.android

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.ParcelFileDescriptor
import androidx.media3.common.util.UnstableApi
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileNotFoundException
import java.util.concurrent.TimeUnit

/** Opaque, explicitly granted thumbnails. Authentication and private cover URLs stay native. */
@UnstableApi
internal class ProgramCarArtwork(private val context: Context, private val connection: EngineConnection) : AutoCloseable {
    companion object {
        @Volatile private var active: ProgramCarArtwork? = null
        fun open(uri: Uri): ParcelFileDescriptor = active?.read(uri) ?: throw FileNotFoundException("Artwork unavailable")
    }
    private data class Entry(val id: String, val generation: Long, val identity: String)
    private val loader = ProgramArtwork(connection)
    private var scope: Pair<Long, String>? = null
    private val lock = Any()
    private val entries = linkedMapOf<String, Entry>()
    private val cached = linkedSetOf<String>()
    private val directory = File(context.cacheDir, "car-artwork")
    private val cleanup = java.util.concurrent.Executors.newSingleThreadExecutor { task -> Thread(task, "soundsible-car-art-clean").apply { isDaemon = true } }
    @Volatile private var closed = false
    init {
        val stale = directory.listFiles()?.toList().orEmpty()
        active = this; cleanup.execute { stale.forEach(File::delete) }
    }
    fun publish(id: String, recipient: String): Uri {
        require(id.isNotBlank() && id.length <= 512 && !closed)
        val generation = connection.generation
        val identity = connection.sessionIdentity(generation) ?: error("No artwork account")
        val owner = generation to identity
        if (scope != owner) {
            if (scope != null) { clear(); loader.clear() }
            scope = owner
        }
        val token = synchronized(lock) {
            entries.entries.firstOrNull { it.value == Entry(id, generation, identity) }?.key ?: java.util.UUID.randomUUID().toString().also {
                entries[it] = Entry(id, generation, identity)
                while (entries.size > 400) {
                    val oldest = entries.keys.first(); entries.remove(oldest); cached.remove(oldest)
                    context.revokeUriPermission(uri(oldest), Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    cleanup.execute { File(directory, oldest).delete() }
                }
            }
        }
        return uri(token).also { context.grantUriPermission(recipient, it, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    }
    private fun uri(token: String): Uri = Uri.Builder().scheme("content").authority(context.packageName + ".carart").appendPath(token).build()
    private fun owns(entry: Entry): Boolean = !closed && entry.generation == connection.generation &&
        runCatching { connection.sessionIdentity(entry.generation) }.getOrNull() == entry.identity
    private fun read(uri: Uri): ParcelFileDescriptor {
        try {
            require(uri.scheme == "content" && uri.authority == context.packageName + ".carart" && uri.query == null && uri.fragment == null)
            val token = uri.pathSegments.singleOrNull() ?: error("Invalid artwork")
            val entry = synchronized(lock) { entries[token] } ?: error("Expired artwork")
            require(owns(entry))
            val target = File(directory, token)
            if (!target.isFile) {
                val image = loader.loadBitmap(ProgramArtwork.uri(entry.generation, entry.id)).get(10, TimeUnit.SECONDS)
                val bytes = ByteArrayOutputStream().apply { require(image.compress(Bitmap.CompressFormat.PNG, 100, this)) }.toByteArray()
                require(bytes.size in 1..ProgramArtwork.MAX_BYTES && owns(entry))
                directory.mkdirs()
                val temporary = File.createTempFile("thumbnail-", ".part", directory)
                try {
                    temporary.outputStream().use { it.write(bytes) }
                    synchronized(lock) {
                        require(owns(entry) && entries[token] == entry)
                        require(temporary.renameTo(target))
                        touch(token)
                    }
                } finally { temporary.delete() }
            }
            return synchronized(lock) {
                require(owns(entry) && entries[token] == entry)
                touch(token)
                ParcelFileDescriptor.open(target, ParcelFileDescriptor.MODE_READ_ONLY)
            }
        } catch (_: Exception) { throw FileNotFoundException("Artwork unavailable") }
    }
    /** With lock held: bounded disk cache; delayed eviction never removes a recently reused URI. */
    private fun touch(token: String) {
        cached.remove(token); cached.add(token)
        while (cached.size > 32) {
            val oldest = cached.first(); cached.remove(oldest)
            cleanup.execute { synchronized(lock) { if (oldest !in cached) File(directory, oldest).delete() } }
        }
    }
    fun clear() {
        val old = synchronized(lock) { entries.keys.toList().also { entries.clear(); cached.clear() } }
        old.forEach { token ->
            context.revokeUriPermission(uri(token), Intent.FLAG_GRANT_READ_URI_PERMISSION)
            cleanup.execute { File(directory, token).delete() }
        }
    }
    override fun close() { closed = true; if (active === this) active = null; clear(); loader.close(); cleanup.shutdown() }
}
