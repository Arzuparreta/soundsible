package com.soundsible.android

import android.content.Context
import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.media.MediaMetadataRetriever
import android.net.Uri
import okhttp3.Call
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.Executors

/** Explicit private copies, scoped to a verified engine/account. No provider resolution or eviction. */
class OfflineStore private constructor(private val context: Context) {
    private val connection = EngineConnection.shared(context)
    private val prefs = context.getSharedPreferences("offline", Context.MODE_PRIVATE)
    private val directory = File(context.filesDir, "offline").apply { mkdirs() }
    private val database = object : SQLiteOpenHelper(context, "offline.db", null, 1) {
        override fun onCreate(db: SQLiteDatabase) { db.execSQL("CREATE TABLE copies (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, state TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, digest TEXT, error TEXT NOT NULL DEFAULT '', ticket TEXT NOT NULL)") }
        override fun onUpgrade(db: SQLiteDatabase, old: Int, next: Int) { error("Unsupported offline schema") }
    }.writableDatabase
    private val worker = Executors.newSingleThreadExecutor()
    private var running = false
    private var active: Pair<String, Call>? = null
    private var revision = 0L
    private val verified = mutableMapOf<String, Long>()
    internal val changes = java.util.concurrent.CopyOnWriteArrayList<() -> Unit>()
    private fun changed() { changes.forEach { listener -> runCatching { listener() } } }
    private fun name(id: String) = MessageDigest.getInstance("SHA-256").digest(id.toByteArray()).joinToString("") { "%02x".format(it) }
    private fun file(id: String) = File(directory, name(id) + ".audio")
    private fun part(id: String) = File(directory, name(id) + ".part")
    private fun digest(file: File): String {
        val hash = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input -> val buffer = ByteArray(65536); while (true) { val count = input.read(buffer); if (count < 0) break; hash.update(buffer, 0, count) } }
        return hash.digest().joinToString("") { "%02x".format(it) }
    }
    init {
        database.execSQL("UPDATE copies SET state='error', error='interrupted', bytes=0 WHERE state IN ('queued','downloading')")
        directory.listFiles()?.filter { it.name.endsWith(".part") }?.forEach { it.delete() }
        // Crash between rename and SQL commit leaves an orphan, never a ready copy.
        val retained = mutableSetOf<String>()
        database.rawQuery("SELECT id FROM copies WHERE state='ready'", null).use { while (it.moveToNext()) retained.add(file(it.getString(0)).name) }
        directory.listFiles()?.filter { it.name.endsWith(".audio") && it.name !in retained }?.forEach { it.delete() }
    }
    @Synchronized fun bind(user: JSONObject) {
        val id = user.optString("id"); require(id.isNotBlank())
        val profile = connection.origin + "|" + id
        if (prefs.getString("profile", "") != profile) clear()
        prefs.edit().putString("profile", profile).putString("origin", connection.origin).putString("user", JSONObject().put("id", user.get("id")).put("display_name", user.optString("display_name")).put("role", user.optString("role")).put("username", user.optString("username")).put("has_password", user.optBoolean("has_password")).toString()).apply()
    }
    @Synchronized fun clear() {
        revision++; active?.second?.cancel(); active = null; verified.clear()
        database.delete("copies", null, null); directory.listFiles()?.forEach { it.delete() }
        prefs.edit().clear().apply()
        changed()
    }
    @Synchronized private fun requireProfile(epoch: Long) {
        require(epoch == connection.generation && prefs.getString("origin", "") == connection.origin && prefs.contains("user")) { "STALE_PROFILE" }
    }
    @Synchronized fun profileKey(epoch: Long): String { requireProfile(epoch); return prefs.getString("profile", "") ?: error("NO_PROFILE") }
    @Synchronized fun canUse(epoch: Long): Boolean = epoch == connection.generation && prefs.getString("origin", "") == connection.origin && prefs.contains("user")
    @Synchronized fun state(epoch: Long): JSONObject {
        require(epoch == connection.generation)
        if (prefs.getString("origin", "") != connection.origin) return JSONObject().put("items", JSONArray()).put("user", JSONObject.NULL)
        val items = JSONArray(); var used = 0L
        database.rawQuery("SELECT id,metadata,state,bytes,total,error FROM copies ORDER BY rowid", null).use { cursor ->
            while (cursor.moveToNext()) {
                val id = cursor.getString(0)
                val complete = cursor.getString(2) == "ready" && local(id,epoch) != null
                val status = if (complete) "ready" else if (cursor.getString(2) == "ready") "error" else cursor.getString(2)
                if (status == "ready") used += cursor.getLong(4)
                else if (cursor.getString(5) == "storage") used += OfflineFileRemoval.retainedBytes(file(id), part(id))
                items.put(JSONObject().put("track", JSONObject(cursor.getString(1))).put("state", status).put("bytes", cursor.getLong(3)).put("total", cursor.getLong(4)).put("error", if (status == "error" && cursor.getString(2) == "ready") "integrity" else cursor.getString(5)))
            }
        }
        return JSONObject().put("items", items).put("user", prefs.getString("user", null)?.let { JSONObject(it) } ?: JSONObject.NULL)
            .put("usedBytes", used).put("limitBytes", prefs.getLong("limit", 2L * 1024 * 1024 * 1024))
            .put("playlists", JSONObject(prefs.getString("playlists", "{}") ?: "{}"))
    }
    @Synchronized fun prepare(epoch: Long, rows: JSONArray, playlists: JSONObject) {
        requireProfile(epoch); require(connection.cookieHeader(epoch) != null)
        require(rows.length() in 1..1000 && playlists.toString().length <= 1024 * 1024)
        val tracks = (0 until rows.length()).map { i ->
            val row = rows.getJSONObject(i)
            require(!row.has("source") && row.optString("media_kind") != "podcast_episode" && (row.isNull("podcast_episode_guid") || row.optString("podcast_episode_guid").isBlank())) { "LOCAL_MUSIC_ONLY" }
            val id = row.getString("id"); require(id.isNotBlank() && id.length <= 512)
            val result = JSONObject().put("id", id)
            for (key in listOf("title", "artist", "album", "album_artist", "album_id", "artist_id")) {
                val value = if(row.isNull(key)) "" else row.optString(key, ""); require(value.length <= 4096); result.put(key, value)
            }
            // Public recording identity allows an incoming capsule to resolve
            // to the acquired copy while offline; never persist an external URL.
            if (!row.isNull("youtube_id")) row.optString("youtube_id").takeIf {
                it.matches(Regex("^[A-Za-z0-9_-]{11}$"))
            }?.let { result.put("youtube_id", it) }
            result.put("duration", row.optDouble("duration", 0.0).takeIf { it.isFinite() && it >= 0 } ?: 0.0)
            // Keep facts with the copied recording; later metadata refreshes may describe different bytes.
            for (key in listOf("loudness_lufs", "loudness_peak_dbtp")) {
                if (!row.isNull(key)) row.optDouble(key).takeIf { it.isFinite() }?.let { result.put(key, it) }
            }
            result
        }.distinctBy { it.getString("id") }
        val existing = mutableSetOf<String>(); database.rawQuery("SELECT id FROM copies", null).use { while(it.moveToNext()) existing.add(it.getString(0)) }
        require((existing + tracks.map { it.getString("id") }).size <= 1000) { "COPY_LIMIT" }
        database.beginTransaction()
        try {
            for (track in tracks) {
                val id = track.getString("id")
                database.rawQuery("SELECT state FROM copies WHERE id=?", arrayOf(id)).use { cursor ->
                    if (cursor.moveToFirst() && cursor.getString(0) in setOf("ready", "queued", "downloading")) return@use
                    database.insertWithOnConflict("copies", null, ContentValues().apply {
                        put("id", id); put("metadata", track.toString()); put("state", "queued"); put("bytes", 0); put("total", 0); put("error", ""); put("ticket", java.util.UUID.randomUUID().toString())
                    }, SQLiteDatabase.CONFLICT_REPLACE)
                }
            }
            database.setTransactionSuccessful()
        } finally { database.endTransaction() }
        prefs.edit().putString("playlists", playlists.toString()).apply()
    }
    /** Refresh labels of existing copies without changing their bytes, digest or download ticket. */
    @Synchronized fun updateMetadata(epoch: Long, rows: JSONArray) {
        if (!canUse(epoch)) return
        var changed = false
        database.beginTransaction()
        try {
            for (i in 0 until rows.length()) {
                val row = rows.getJSONObject(i); val id = row.getString("id")
                database.rawQuery("SELECT metadata FROM copies WHERE id=?", arrayOf(id)).use { cursor ->
                    if (!cursor.moveToFirst()) return@use
                    val saved = JSONObject(cursor.getString(0))
                    val previous = saved.toString()
                    for (key in listOf("title", "artist", "album", "album_artist", "album_id", "artist_id")) if (row.has(key)) saved.put(key, row.get(key))
                    if (previous != saved.toString()) {
                        database.update("copies", ContentValues().apply { put("metadata", saved.toString()) }, "id=?", arrayOf(id))
                        changed = true
                    }
                }
            }
            database.setTransactionSuccessful()
        } finally { database.endTransaction() }
        if (changed) changed()
    }
    @Synchronized fun limit(epoch: Long, bytes: Long) { requireProfile(epoch); require(bytes in setOf(512L * 1024 * 1024, 2L * 1024 * 1024 * 1024, 8L * 1024 * 1024 * 1024)); prefs.edit().putLong("limit", bytes).apply() }
    @Synchronized fun remove(epoch: Long, ids: JSONArray) {
        requireProfile(epoch)
        require(ids.length() <= 1000)
        val sources = (0 until ids.length()).map { ids.getString(it).also { id -> require(id.isNotBlank() && id.length <= 512) } }.toSet()
        var failed = false
        for (id in sources) {
            active?.takeIf { it.first == id }?.second?.cancel()
            verified.remove(id)
            // Retire the download ticket and availability before touching files.
            // If deletion fails, retain an error row so removal can be retried.
            database.update("copies", ContentValues().apply {
                put("state", "error"); put("error", "storage"); put("ticket", java.util.UUID.randomUUID().toString()); put("bytes", OfflineFileRemoval.retainedBytes(file(id), part(id)))
            }, "id=?", arrayOf(id))
            try {
                OfflineFileRemoval.remove(file(id), part(id))
                database.delete("copies", "id=?", arrayOf(id))
            } catch (_: java.io.IOException) {
                failed = true
                database.update("copies", ContentValues().apply { put("bytes", OfflineFileRemoval.retainedBytes(file(id), part(id))) }, "id=?", arrayOf(id))
            }
        }
        val playlists = JSONObject(prefs.getString("playlists", "{}") ?: "{}")
        for (name in playlists.keys().asSequence().toList()) {
            val rows = playlists.getJSONArray(name); val retained = JSONArray()
            for (index in 0 until rows.length()) if (rows.getString(index) !in sources) retained.put(rows.getString(index))
            playlists.put(name, retained)
        }
        prefs.edit().putString("playlists", playlists.toString()).apply()
        changed()
        if (failed) throw java.io.IOException("storage")
    }
    @Synchronized fun interrupt() {
        revision++; active?.second?.cancel(); active = null
        database.execSQL("UPDATE copies SET state='error',error='interrupted',bytes=0 WHERE state IN ('queued','downloading')")
    }
    @Synchronized fun active(): Boolean = running
    @Synchronized fun idle(): Boolean = !running && database.rawQuery("SELECT 1 FROM copies WHERE state='queued' LIMIT 1", null).use { !it.moveToFirst() }
    @Synchronized fun run(done: () -> Unit) {
        if (running) return
        running = true
        worker.execute {
            try { while (true) {
                val job = synchronized(this) { database.rawQuery("SELECT id,ticket FROM copies WHERE state='queued' LIMIT 1", null).use { if(it.moveToFirst()) Pair(it.getString(0),it.getString(1)) else null } } ?: break
                download(job.first, job.second)
            } } finally { synchronized(this) { running = false }; done() }
        }
    }
    @Synchronized private fun valid(id: String, ticket: String, epoch: Long, rev: Long): Boolean = epoch == connection.generation && revision == rev && database.rawQuery("SELECT ticket FROM copies WHERE id=?", arrayOf(id)).use { it.moveToFirst() && it.getString(0) == ticket }
    private fun download(id: String, ticket: String) {
        val epoch = connection.generation; val rev = synchronized(this) { revision }; val output = part(id)
        try {
            synchronized(this) { requireProfile(epoch); require(valid(id,ticket,epoch,rev)); database.execSQL("UPDATE copies SET state='downloading' WHERE id=? AND ticket=?", arrayOf(id,ticket)) }
            val cookie = connection.cookieHeader(epoch) ?: error("session")
            val call = connection.client.newBuilder().retryOnConnectionFailure(false).callTimeout(30, java.util.concurrent.TimeUnit.MINUTES).build().newCall(Request.Builder().url(connection.origin + "/api/static/stream/" + Uri.encode(id)).header("Cookie", cookie).build())
            synchronized(this) { require(valid(id,ticket,epoch,rev)); active = id to call }
            call.execute().use { response ->
                if (response.code == 401) { clear(); error("session") }
                require(response.code == 200) { if(response.code == 403) "permission" else "server" }
                val body = response.body ?: error("integrity"); val total = body.contentLength(); require(total > 0) { "integrity" }
                synchronized(this) {
                    require(valid(id,ticket,epoch,rev))
                    var used = database.rawQuery("SELECT COALESCE(SUM(total),0) FROM copies WHERE state='ready'", null).use { it.moveToFirst(); it.getLong(0) }
                    database.rawQuery("SELECT id FROM copies WHERE state='error' AND error='storage'", null).use { retained ->
                        while (retained.moveToNext()) { val source = retained.getString(0); used += OfflineFileRemoval.retainedBytes(file(source), part(source)) }
                    }
                    require(total <= prefs.getLong("limit", 2L * 1024 * 1024 * 1024) - used && total + 16L * 1024 * 1024 < directory.usableSpace) { "space" }
                    database.execSQL("UPDATE copies SET total=? WHERE id=? AND ticket=?", arrayOf<Any>(total,id,ticket))
                }
                FileOutputStream(output).use { sink -> body.byteStream().use { input ->
                    val buffer = ByteArray(65536); var count = 0L; var last = 0L
                    while (true) {
                        val n = input.read(buffer); if(n < 0) break
                        require(valid(id,ticket,epoch,rev)); count += n; require(count <= total) { "integrity" }; sink.write(buffer,0,n)
                        if (count-last >= 262144) { synchronized(this) { database.execSQL("UPDATE copies SET bytes=? WHERE id=? AND ticket=?", arrayOf<Any>(count,id,ticket)) }; last=count }
                    }
                    require(count == total) { "integrity" }; sink.fd.sync()
                } }
                val media = MediaMetadataRetriever()
                try { media.setDataSource(output.path); require((media.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0) > 0) { "integrity" } }
                catch (_: Exception) { error("integrity") } finally { media.release() }
                val checksum = digest(output)
                synchronized(this) {
                    require(valid(id,ticket,epoch,rev)); require(output.renameTo(file(id))) { "storage" }
                    database.execSQL("UPDATE copies SET state='ready',bytes=total,digest=?,error='' WHERE id=? AND ticket=?", arrayOf(checksum,id,ticket)); verified[id] = file(id).lastModified()
                }
            }
        } catch (error: Exception) {
            synchronized(this) { if(valid(id,ticket,epoch,rev)) database.execSQL("UPDATE copies SET state='error',bytes=0,error=? WHERE id=? AND ticket=?", arrayOf(error.message?.takeIf { it in setOf("space","integrity","permission","server","session","storage") } ?: "network",id,ticket)) }
        } finally { synchronized(this) { if(active?.first==id) active=null }; output.delete(); changed() }
    }
    @Synchronized private fun invalid(id: String) { verified.remove(id); database.execSQL("UPDATE copies SET state='error',error='integrity',bytes=0 WHERE id=?", arrayOf(id)); file(id).delete(); changed() }
    /** Native-only lookup. Paths never cross the bridge; full hash checked once per process. */
    @Synchronized fun local(id: String, epoch: Long): File? {
        requireProfile(epoch)
        database.rawQuery("SELECT total,digest FROM copies WHERE id=? AND state='ready'", arrayOf(id)).use {
            if (!it.moveToFirst()) return null
            val target=file(id)
            if (!target.exists() || target.length()!=it.getLong(0) || (verified[id] != target.lastModified() && digest(target)!=it.getString(1))) { invalid(id); return null }
            verified[id] = file(id).lastModified(); return target
        }
    }
    companion object {
        @Volatile private var instance: OfflineStore? = null
        @JvmStatic fun shared(context: Context): OfflineStore = synchronized(this) { instance ?: OfflineStore(context.applicationContext).also { instance=it } }
    }
}
