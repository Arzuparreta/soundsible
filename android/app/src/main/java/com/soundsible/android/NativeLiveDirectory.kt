package com.soundsible.android

import com.getcapacitor.JSObject
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Selected Core determines the public relay; the WebView never requests arbitrary JSON origins. */
internal class NativeLiveAuthenticationExpired : Exception()

internal object NativeLiveDirectory {
    fun load(connection: EngineConnection, epoch: Long, id: String): JSObject {
        val config = connection.execute("/api/community/config", "GET", null, emptyMap(), epoch, id, 10000).use {
            if (it.code == 401) { connection.clearSession(false); throw NativeLiveAuthenticationExpired() }
            check(it.isSuccessful) { "LIVE_CONFIG_${it.code}" }
            val bytes = it.peekBody(65537).bytes(); require(bytes.size <= 65536)
            JSONObject(String(bytes, Charsets.UTF_8))
        }
        check(connection.generation == epoch)
        if (config.optString("state") != "available") return JSObject().put("config", config).put("sessions", org.json.JSONArray())
        val origin = config.getString("api_url").toHttpUrl()
        require(origin.isHttps && origin.username.isEmpty() && origin.password.isEmpty())
        val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).callTimeout(10, TimeUnit.SECONDS).build()
        try {
            val sessions = client.newCall(Request.Builder().url(origin.resolve("/v1/sessions")!!).build()).execute().use {
                check(it.isSuccessful) { "LIVE_DIRECTORY_${it.code}" }
                val bytes = it.peekBody(1048577).bytes(); require(bytes.size <= 1048576)
                JSONObject(String(bytes, Charsets.UTF_8)).getJSONArray("sessions").also { value -> require(value.length() <= 100) }
            }
            check(connection.generation == epoch)
            return JSObject().put("config", config).put("sessions", sessions)
        } finally { client.dispatcher.cancelAll(); client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
    }
}
