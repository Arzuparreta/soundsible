package com.soundsible.android

import android.content.Intent
import android.net.Uri
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/** Explicit share-sheet launch. Account credentials and private stream addresses never become attachments. */
@CapacitorPlugin(name = "SoundsibleShare")
class SharePlugin : Plugin() {
    @PluginMethod
    fun open(call: PluginCall) {
        val epoch = call.getInt("generation")?.toLong() ?: call.getLong("generation") ?: -1L
        val title = call.getString("title")
        val text = call.getString("text")
        val url = call.getString("url")
        if (title.isNullOrBlank() || title.length > 1024 || text.isNullOrBlank() || text.length > 4096 ||
            url != null && !publicCapsule(url)) {
            call.reject("A supported share value is required.", "INVALID_SHARE"); return
        }
        val connection = EngineConnection.shared(context)
        val identity = runCatching { connection.sessionIdentity(epoch) }.getOrNull()
        if (identity == null) { call.reject("Share account is no longer active.", "SHARE_SESSION_CHANGED"); return }
        activity.runOnUiThread {
            if (activity.isFinishing || !bridge.webView.hasWindowFocus() || epoch != connection.generation ||
                runCatching { connection.sessionIdentity(epoch) }.getOrNull() != identity) {
                call.reject("Share account is no longer active.", "SHARE_SESSION_CHANGED"); return@runOnUiThread
            }
            try {
                val send = Intent(Intent.ACTION_SEND).setType("text/plain")
                    .putExtra(Intent.EXTRA_TITLE, title).putExtra(Intent.EXTRA_TEXT, if (url == null) text else "$text\n$url")
                activity.startActivity(Intent.createChooser(send, null))
                // A launched chooser is not evidence that the user sent anything.
                call.resolve(JSObject().put("opened", true))
            } catch (_: Exception) { call.reject("The system share sheet is unavailable.", "SHARE_UNAVAILABLE") }
        }
    }
    private fun publicCapsule(value: String): Boolean {
        if (value.length > 8192) return false
        val uri = Uri.parse(value)
        return uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.userInfo == null && uri.query == null &&
            uri.fragment?.matches(Regex("^t=[A-Za-z0-9_-]{1,4096}$")) == true
    }
}
