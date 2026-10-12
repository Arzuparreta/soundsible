package com.soundsible.android

import io.socket.client.IO
import io.socket.client.Socket
import io.socket.thread.EventThread
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class SocketIoCallFactoryTest {
    @Test fun pollingClosesWithoutReenteringOnRejectedExecutor() {
        val client = OkHttpClient()
        client.dispatcher.executorService.shutdown()
        val requests = AtomicInteger()
        // Deliver a handshake, then use the real rejected OkHttp executor for
        // the next poll, namespace connect and Engine.IO's final close packet.
        val factory = Call.Factory { request ->
            val call = client.newCall(request)
            if (requests.incrementAndGet() == 1) object : Call by call {
                override fun enqueue(callback: Callback) {
                    EventThread.nextTick {
                        callback.onResponse(this, Response.Builder().request(request)
                            .protocol(Protocol.HTTP_1_1).code(200).message("OK")
                            .body("0{\"sid\":\"fixture\",\"upgrades\":[],\"pingInterval\":25000,\"pingTimeout\":20000}".toResponseBody())
                            .build())
                    }
                }
            } else call
        }
        val failed = CountDownLatch(1)
        val socket = IO.socket("http://127.0.0.1:9", IO.Options().apply {
            forceNew = true; reconnection = false; transports = arrayOf("polling")
            callFactory = SocketIoCallFactory(factory); webSocketFactory = client
        })
        try {
            socket.on(Socket.EVENT_CONNECT_ERROR) { failed.countDown() }
            socket.connect()
            assertTrue("Polling must report rejection", failed.await(5, TimeUnit.SECONDS))
            val drained = CountDownLatch(1)
            EventThread.nextTick { drained.countDown() }
            assertTrue(drained.await(5, TimeUnit.SECONDS))
            assertTrue("Handshake and rejected follow-up were exercised", requests.get() >= 2)
            assertTrue("Close must not recurse", requests.get() <= 5)
        } finally { socket.off(); socket.disconnect(); client.connectionPool.evictAll() }
    }
}
