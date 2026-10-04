package com.soundsible.player

import android.os.Build
import android.util.Log
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

    /** Why Python failed to start, for the UI. Null when it started fine. */
    @Volatile var startupError: String? = null
        private set

    /** Raw subprocess-python probe JSON, for the boot trace. */
    @Volatile var subprocessInfo: String? = null
        private set

    /** True while a boot attempt is still running. */
    val isBooting: Boolean get() = _booting.get()
    private val _booting = java.util.concurrent.atomic.AtomicBoolean(false)

    private var traceFile: File? = null

    private fun trace(msg: String) {
        try {
            traceFile?.appendText("${System.currentTimeMillis()} $msg\n")
        } catch (_: Exception) {
        }
    }

    /** Last lines of the boot trace, for the UI. Empty when boot never ran. */
    fun traceTail(maxChars: Int = 1200): String {
        return try {
            val text = traceFile?.takeIf { it.exists() }?.readText() ?: ""
            if (text.length <= maxChars) text else "…${text.takeLast(maxChars)}"
        } catch (_: Exception) {
            ""
        }
    }

    /**
     * One-line device facts for the unavailable message: CPU ABIs and free
     * internal storage, the two environmental causes of a dead interpreter.
     */
    fun deviceFacts(filesDir: File): String {
        val abis = Build.SUPPORTED_ABIS.joinToString(",")
        val freeMb = try {
            filesDir.usableSpace / (1024 * 1024)
        } catch (_: Exception) {
            -1
        }
        return "ABI [$abis] free ${freeMb}MB"
    }

    /**
     * Copy the bundled web player (APK assets/ui-dist) into [uiDir] for the
     * engine to serve. Reinstalls when the APK version changes: otherwise an
     * updated bundle (bridge calls, route fixes) never reaches an existing
     * install, and the page silently lacks what the app expects. Returns
     * false when the APK carries no bundle.
     */
    fun installWebUi(
        assetManager: android.content.res.AssetManager,
        uiDir: File,
        apkVersionCode: Long,
    ): Boolean {
        return try {
            val sentinel = File(uiDir, ".apk-version")
            val installed = sentinel.takeIf { it.isFile }?.readText()?.trim()?.toLongOrNull()
            if (File(uiDir, "index.html").isFile && installed == apkVersionCode) return true
            uiDir.deleteRecursively()
            val names = assetManager.list("ui-dist") ?: return false
            if (names.isEmpty()) return false
            copyAssetDir(assetManager, "ui-dist", uiDir)
            if (!File(uiDir, "index.html").isFile) return false
            try {
                sentinel.writeText(apkVersionCode.toString())
            } catch (_: Exception) {
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun copyAssetDir(
        assetManager: android.content.res.AssetManager,
        assetPath: String,
        outDir: File,
    ) {
        val names = assetManager.list(assetPath) ?: return
        outDir.mkdirs()
        for (name in names) {
            val childAsset = if (assetPath.isEmpty()) name else "$assetPath/$name"
            val childOut = File(outDir, name)
            val nested = assetManager.list(childAsset)
            if (nested != null && nested.isNotEmpty()) {
                copyAssetDir(assetManager, childAsset, childOut)
            } else {
                assetManager.open(childAsset).use { input ->
                    childOut.outputStream().use { output -> input.copyTo(output) }
                }
            }
        }
    }

    /**
     * Plain health check against a base URL. No auth: /api/health is public.
     * Used by the splash router to decide whether the server needs a restart.
     */
    fun isHealthy(baseUrl: String): Boolean {
        return try {
            val conn = java.net.URL("$baseUrl/api/health").openConnection()
                as java.net.HttpURLConnection
            conn.connectTimeout = 2_000
            conn.readTimeout = 2_000
            try {
                conn.responseCode in 200..299
            } finally {
                conn.disconnect()
            }
        } catch (_: Exception) {
            false
        }
    }

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

    fun start(platform: AndroidPlatform, filesDir: File) {
        // One boot at a time: concurrent Python.start() calls from the app
        // boot thread and tap-to-retry pile up inside the native loader.
        if (!_booting.compareAndSet(false, true)) return
        traceFile = File(filesDir, "python-boot-trace.log")
        try {
            trace("boot-enter isStarted=${Python.isStarted()}")
            if (!Python.isStarted()) {
                trace("python-start-begin")
                Python.start(platform)
                trace("python-start-return")
            }
            trace("import-soundsible_local")
            // Read the probes as JSON strings, not bridge dicts: key lookup
            // on returned mappings read back null on device despite present
            // keys. Strings round-trip exactly.
            val probeMod = Python.getInstance().getModule("soundsible_local")
            val raw = probeMod.callAttr("runtime_info_json").toString()
            trace("probe-return raw=$raw")
            val probe = parseJsonObject(raw)
            pythonVersion = probe.optString("python_version", "").ifEmpty { null }
            sqliteVersion = probe.optString("sqlite_version", "").ifEmpty { null }
            trace("probed python=$pythonVersion sqlite=$sqliteVersion")
            try {
                val subRaw = probeMod.callAttr("subprocess_python_json").toString()
                trace("subprocess-probe raw=$subRaw")
                subprocessInfo = subRaw
            } catch (t: Throwable) {
                trace("subprocess-probe failed: ${chainOf(t).take(200)}")
            }
            if (pythonVersion == null) {
                startupError = "probe returned no version: ${raw.take(200)}"
            } else {
                startupError = null
            }
        } catch (t: Throwable) {
            // Throwable, not Exception: native loader failures arrive as
            // UnsatisfiedLinkError and friends, which Exception misses and
            // which used to leave the UI blaming "unavailable" with no cause.
            Log.e("SoundsiblePython", "Embedded Python failed to start", t)
            trace("FAILED ${chainOf(t).take(300)}")
            pythonVersion = null
            sqliteVersion = null
            startupError = chainOf(t).take(400)
        } finally {
            _booting.set(false)
            trace("boot-exit available=$isAvailable")
        }
    }

    private fun chainOf(e: Throwable): String {
        val parts = mutableListOf<String>()
        var cur: Throwable? = e
        while (cur != null && parts.size < 3) {
            parts += "${cur.javaClass.simpleName}: ${cur.message}"
            cur = cur.cause
        }
        return parts.joinToString(" <- ")
    }

    /** Test seam: reset probed state without an interpreter. */
    internal fun resetForTests() {
        pythonVersion = null
        sqliteVersion = null
        startupError = null
        subprocessInfo = null
    }
}
