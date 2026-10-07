package com.soundsible.android

import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Request
import okhttp3.Response
import org.junit.Assert.*
import org.junit.Assume.assumeNotNull
import org.junit.Test
import java.io.IOException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** An obsolete async request must fail by callback, never crash OkHttp's dispatcher. */
class TransportResetTest {
    @Test fun httpObsoleteAsyncClient() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"))
    @Test fun tlsObsoleteAsyncClient() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"))
    private fun run(origin: String?) {
        assumeNotNull(origin)
        val connection = EngineConnection(InstrumentationRegistry.getInstrumentation().targetContext)
        connection.clearSession(true)
        try {
            connection.configure(origin!!)
            for (forget in listOf(false, true)) {
                val previous = connection.client
                // The same-origin case must also reject the old generation.
                if (forget) connection.clearSession(true) else connection.configure(origin)
                val result = CompletableFuture<String>()
                previous.newCall(Request.Builder().url(origin + "/api/library").build()).enqueue(object : Callback {
                    override fun onFailure(call: Call, error: IOException) { result.complete(error.message) }
                    override fun onResponse(call: Call, response: Response) {
                        response.close(); result.complete("Obsolete request reached server")
                    }
                })
                assertEquals("STALE_SESSION", result.get(10, TimeUnit.SECONDS))
            }
        } finally { connection.clearSession(true) }
    }
}
