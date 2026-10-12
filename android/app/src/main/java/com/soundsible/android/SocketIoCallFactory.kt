package com.soundsible.android

import io.socket.thread.EventThread
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Request
import okhttp3.Response
import java.io.IOException

/** Engine.IO closes polling from onFailure. A rejected OkHttp executor can
 * invoke that callback inline, re-entering close before its state is CLOSED.
 * Queue failures on Engine.IO's event thread so teardown can finish first. */
internal class SocketIoCallFactory(private val delegate: Call.Factory) : Call.Factory {
    override fun newCall(request: Request): Call = wrap(delegate.newCall(request))

    private fun wrap(call: Call): Call = object : Call by call {
        override fun clone(): Call = wrap(call.clone())
        override fun enqueue(callback: Callback) {
            val wrapped = this
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    EventThread.nextTick { callback.onFailure(wrapped, e) }
                }
                override fun onResponse(call: Call, response: Response) {
                    callback.onResponse(wrapped, response)
                }
            })
        }
    }
}
