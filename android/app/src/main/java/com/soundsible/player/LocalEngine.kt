package com.soundsible.player

import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import com.soundsible.player.data.ServerConnection
import com.soundsible.player.data.parseJsonObject
import java.io.File

/**
 * On-device Python runtime, embedded via Chaquopy.
 *
 * v1 scope is deliberately narrow: boot the interpreter and run the stdlib
 * probe (`soundsible_local.runtime_info`) so the app can report whether local
 * execution works on this phone. The full engine port (server, acquisition,
 * FFmpeg, media scanning) is staged work; see docs/ANDROID.md.
 *
 * Everything here is best-effort and never throws: if Python fails to start,
 * the app still works as a remote client for a paired server.
 */
object LocalEngine {
    /** Python version running on device, or null when unavailable. */
    @Volatile var pythonVersion: String? = null
        private set

    /** sqlite version of the embedded interpreter, or null when unavailable. */
    @Volatile var sqliteVersion: String? = null
        private set

    val isAvailable: Boolean get() = pythonVersion != null

    /** Loopback engine state, once it has written its runtime file. */
    data class LocalState(val baseUrl: String, val ownerTokenFile: String)

    /**
     * Configure engine directories under [filesDir] and boot the real server
     * on a background thread. Call off the main thread; returns immediately.
     * Progress via `status()` on the Python module.
     */
    fun startLocalServer(filesDir: File): Boolean {
        return try {
            if (!Python.isStarted()) return false
            val root = File(filesDir, "soundsible")
            val mod = Python.getInstance().getModule("soundsible_android")
            mod.callAttr(
                "configure",
                File(root, "config").absolutePath,
                File(root, "data").absolutePath,
                File(root, "cache").absolutePath,
                File(root, "log").absolutePath,
                File(root, "music").absolutePath,
                File(root, "ui").absolutePath,
            )
            File(root, "ui").mkdirs()
            mod.callAttr("start")
            true
        } catch (_: Exception) {
            false
        }
    }

    /** Boot phase of the local server ("idle", "starting", "ready", "error"). */
    fun localStatus(): Pair<String, String?> {
        return try {
            val s = Python.getInstance().getModule("soundsible_android").callAttr("status")
            (s.get("phase")?.toString() ?: "unknown") to s.get("error")?.toString()
        } catch (_: Exception) {
            "unknown" to null
        }
    }

    /**
     * Read the ready server's base URL plus owner token and build the
     * connection the client stores. Null until the server is ready.
     */
    fun localConnection(): ServerConnection? {
        return try {
            val mod = Python.getInstance().getModule("soundsible_android")
            val raw = mod.callAttr("state_file_contents")?.toString() ?: return null
            val state = parseJsonObject(raw)
            val baseUrl = state.optString("base_url", "").ifEmpty { return null }
            val tokenFile = state.optString("owner_token_file", "").ifEmpty { return null }
            val token = mod.callAttr("read_owner_token", tokenFile)?.toString()?.trim()
            if (token.isNullOrEmpty()) return null
            ServerConnection(baseUrl.trimEnd('/'), token, "This phone")
        } catch (_: Exception) {
            null
        }
    }

    fun start(platform: AndroidPlatform) {
        try {
            if (!Python.isStarted()) {
                Python.start(platform)
            }
            val info = Python.getInstance().getModule("soundsible_local").callAttr("runtime_info")
            pythonVersion = info.get("python_version")?.toString()
            sqliteVersion = info.get("sqlite_version")?.toString()
        } catch (_: Exception) {
            pythonVersion = null
            sqliteVersion = null
        }
    }

    /** Test seam: reset probed state without an interpreter. */
    internal fun resetForTests() {
        pythonVersion = null
        sqliteVersion = null
    }
}
