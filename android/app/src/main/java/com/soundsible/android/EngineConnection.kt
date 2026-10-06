package com.soundsible.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.net.InetAddress
import java.security.KeyStore
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** One selected instance and one account. Secrets never cross the JS bridge. */
class EngineConnection(private val context: Context) {
    val offline: OfflineStore get() = OfflineStore.shared(context)
    private val prefs = context.getSharedPreferences("engine", Context.MODE_PRIVATE)
    private val lock = Any()
    @Volatile var generation = 0L
        private set
    @Volatile var origin = prefs.getString("origin", "") ?: ""
        private set
    private var cookie: Cookie? = null
    private val cancelled = ConcurrentHashMap<String, Long>()
    private val calls = ConcurrentHashMap<String, Call>()
    var onReset: () -> Unit = {}
    val resetListeners = java.util.concurrent.CopyOnWriteArrayList<() -> Unit>()
    private data class Transport(val origin: String, val generation: Long, val client: OkHttpClient)
    private var activeTransport: Transport? = null
    val client: OkHttpClient get() = synchronized(lock) { transport(origin, generation) }
    private fun transport(selected: String, epoch: Long): OkHttpClient = synchronized(lock) {
        require(selected == origin && epoch == generation) { "STALE_SESSION" }
        activeTransport?.takeIf { it.origin == selected && it.generation == epoch }?.let { return@synchronized it.client }
        activeTransport?.client?.let { it.dispatcher.cancelAll(); it.connectionPool.evictAll() }
        buildTransport(selected, epoch).also { activeTransport = Transport(selected, epoch, it) }
    }
    private fun buildTransport(selected: String, epoch: Long = generation): OkHttpClient {
        val target = selected.toHttpUrl()
        return OkHttpClient.Builder()
            .followRedirects(false).followSslRedirects(false)
            .connectTimeout(8, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
            .cache(null)
            .addInterceptor { chain ->
                val req = chain.request()
                // OkHttp's async dispatcher reports IOExceptions to onFailure;
                // unchecked exceptions here can terminate the application.
                if (req.url.scheme != target.scheme || req.url.host != target.host || req.url.port != target.port)
                    throw java.io.IOException("ENGINE_ORIGIN_ONLY")
                if (origin != selected || generation != epoch) throw java.io.IOException("STALE_SESSION")
                // Android denies general cleartext. Only this reserved routing
                // alias has an OS exception; DNS below pins it to private addresses
                // of the explicitly selected engine. Host remains the real server.
                val outgoing = if (target.isHttps) req else req.newBuilder()
                    .url(req.url.newBuilder().host(PRIVATE_ALIAS).build())
                    .header("Host", target.toString().substringAfter("://").substringBefore('/')).build()
                chain.proceed(outgoing)
            }
            .dns(object : Dns { override fun lookup(hostname: String): List<InetAddress> {
                if (hostname != PRIVATE_ALIAS) return Dns.SYSTEM.lookup(hostname)
                if (target.isHttps) throw java.net.UnknownHostException("PRIVATE_ALIAS_ONLY")
                val addresses = Dns.SYSTEM.lookup(target.host)
                if (addresses.any { !privateAddress(it) }) throw java.net.UnknownHostException("HTTP_PRIVATE_ONLY")
                return addresses
            } }).build()
    }

    init {
        if (origin.isNotEmpty()) {
            try { cookie = prefs.getString("session", null)?.let { Cookie.parse(origin.toHttpUrl(), decrypt(it)) } }
            catch (_: Exception) { prefs.edit().remove("session").apply() }
        }
    }

    fun configure(input: String): Long {
        val url = input.toHttpUrlOrNull() ?: error("INVALID_SERVER")
        require(url.encodedUsername.isEmpty() && url.encodedPassword.isEmpty() && url.encodedPath == "/" &&
            url.query == null && url.fragment == null) { "ORIGIN_ONLY" }
        require(url.isHttps || InetAddress.getAllByName(url.host).all { privateAddress(it) }) { "HTTP_PRIVATE_ONLY" }
        val next = url.toString().removeSuffix("/")
        val previous = origin
        val result = synchronized(lock) {
            resetLocked()
            if (next != origin) { cookie = null; prefs.edit().remove("session").apply() }
            origin = next
            prefs.edit().putString("origin", origin).apply()
            generation
        }
        if (previous != next) offline.clear() else offline.interrupt()
        return result
    }

    fun clearSession(forget: Boolean = false) { synchronized(lock) {
        resetLocked()
        cookie = null
        prefs.edit().remove("session").apply()
        if (forget) { origin = ""; prefs.edit().remove("origin").apply() }
    }; offline.clear() }

    private fun resetLocked() {
        generation++
        activeTransport?.client?.let {
            it.dispatcher.cancelAll()
            it.connectionPool.evictAll()
        }
        activeTransport = null
        calls.values.forEach { it.cancel() }
        calls.clear()
        onReset()
        resetListeners.forEach { it() }
    }

    fun close() { synchronized(lock) { resetLocked() }; offline.interrupt() }

    fun cancel(id: String) {
        // The bridge can receive cancel before the executor has registered its Call.
        cancelled[id] = System.currentTimeMillis()
        cancelled.entries.removeIf { it.value < System.currentTimeMillis() - 120000 }
        calls.remove(id)?.cancel()
    }

    fun cookieHeader(epoch: Long): String? = synchronized(lock) {
        require(epoch == generation) { "STALE_SESSION" }
        cookie?.takeIf { it.expiresAt > System.currentTimeMillis() && (!it.secure || origin.startsWith("https://")) }?.let { "${it.name}=${it.value}" }
    }

    /** Native-only session identity: binds transient file grants even before a profile response arrives. */
    fun sessionIdentity(epoch: Long): String? = cookieHeader(epoch)?.let {
        Base64.encodeToString(java.security.MessageDigest.getInstance("SHA-256").digest(it.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
    }

    fun execute(path: String, method: String, body: RequestBody?, headers: Map<String, String>,
                epoch: Long, id: String, timeout: Long): Response {
        require(path.startsWith("/api/") && !path.contains('\\')) { "API_PATH_ONLY" }
        require(method in setOf("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"))
        val request: Request
        val selected: String
        synchronized(lock) {
            require(epoch == generation && origin.isNotEmpty()) { "STALE_SESSION" }
            selected = origin
            val url = (selected + path).toHttpUrl()
            require(url.encodedPath.startsWith("/api/"))
            val builder = Request.Builder().url(url).method(method, body)
            headers.forEach { (key, value) ->
                require(key.lowercase() in setOf("content-type", "if-none-match", "range", "accept"))
                builder.header(key, value)
            }
            cookieHeader(epoch)?.let { builder.header("Cookie", it) }
            request = builder.build()
        }
        val call = transport(selected, epoch).newCall(request)
        call.timeout().timeout(timeout.coerceIn(1, 120000), TimeUnit.MILLISECONDS)
        synchronized(lock) {
            require(epoch == generation)
            if (cancelled.remove(id) != null) { call.cancel(); throw java.io.IOException("CANCELLED") }
            calls[id] = call
        }
        try {
            val response = call.execute()
            synchronized(lock) {
                if (epoch != generation) { response.close(); error("STALE_SESSION") }
                // Only our HttpOnly session cookie; no general WebView cookie jar.
                response.headers.values("Set-Cookie").mapNotNull { Cookie.parse(request.url, it) }
                    .filter { it.name == "sb_session" && it.httpOnly }.lastOrNull()?.let {
                        cookie = it.takeIf { c -> c.expiresAt > System.currentTimeMillis() }
                        val editor = prefs.edit()
                        if (cookie == null) editor.remove("session")
                        else editor.putString("session", encrypt(cookie.toString()))
                        editor.apply()
                    }
            }
            return response
        } finally { calls.remove(id, call); cancelled.remove(id) }
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("soundsible-session", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("soundsible-session", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        return Base64.encodeToString(cipher.iv + cipher.doFinal(value.toByteArray()), Base64.NO_WRAP)
    }
    private fun decrypt(value: String): String {
        val bytes = Base64.decode(value, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        }
        return String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)))
    }
    companion object {
        @Volatile private var shared: EngineConnection? = null
        @JvmStatic fun shared(context: Context): EngineConnection = synchronized(this) {
            shared ?: EngineConnection(context.applicationContext).also { shared = it }
        }
        const val PRIVATE_ALIAS = "soundsible-private.invalid"
        fun privateAddress(address: InetAddress): Boolean {
            val bytes = address.address
            return address.isLoopbackAddress || address.isSiteLocalAddress ||
                (bytes.size == 4 && (bytes[0].toInt() and 255) == 100 && (bytes[1].toInt() and 255) in 64..127) ||
                (bytes.size == 16 && (bytes[0].toInt() and 254) == 252)
        }
    }
}
