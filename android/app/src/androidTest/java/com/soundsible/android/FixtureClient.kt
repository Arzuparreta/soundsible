package com.soundsible.android

import okhttp3.Dns
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import java.net.UnknownHostException

/**
 * A test client that reaches a fixture by the same verified HTTPS and private cleartext routing as
 * the app, but owns its dispatcher and session: the app signing out or reconfiguring retires its
 * own transport and cancels every call on it, never this client's.
 */
object FixtureClient {
    @JvmStatic fun builder(origin: HttpUrl): OkHttpClient.Builder = OkHttpClient.Builder()
        .followRedirects(false).followSslRedirects(false)
        .dns(object : Dns { override fun lookup(hostname: String) =
            if (hostname != EngineConnection.PRIVATE_ALIAS) Dns.SYSTEM.lookup(hostname)
            else Dns.SYSTEM.lookup(origin.host).onEach {
                if (!EngineConnection.privateAddress(it)) throw UnknownHostException("Fixture must be private")
            } })
        .addInterceptor { chain ->
            val request = chain.request()
            chain.proceed(if (origin.isHttps) request else request.newBuilder()
                .url(request.url.newBuilder().host(EngineConnection.PRIVATE_ALIAS).build())
                .header("Host", "${origin.host}:${origin.port}").build())
        }
}
