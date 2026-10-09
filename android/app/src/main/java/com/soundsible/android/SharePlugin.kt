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
    private var initialDispatch = true
    override fun handleOnNewIntent(intent: Intent) {
        // BridgeActivity.load dispatches getIntent even on recreation. Consume
        // that initial dispatch once; later OS intents remain independent.
        if (initialDispatch) {
            initialDispatch = false
            if ((activity as? MainActivity)?.restoredInstance == true) return
        }
        // Listeners live on Capacitor's thread; see PlaybackPlugin.publish.
        IncomingTrackState.accept(context, intent)?.let { bridge.execute { notifyListeners("incomingTrack", it) } }
    }
    @PluginMethod fun incoming(call: PluginCall) { call.resolve(JSObject().put("incoming", IncomingTrackState.pending(context))) }
    @PluginMethod fun dismiss(call: PluginCall) {
        val token = call.getString("token")
        if (token.isNullOrBlank() || token.length > 64) { call.reject("Incoming link identity is required.", "INVALID_INCOMING"); return }
        call.resolve(JSObject().put("dismissed", IncomingTrackState.dismiss(context, token)))
    }
    @PluginMethod
    fun open(call: PluginCall) {
        val epoch = call.getInt("generation")?.toLong() ?: call.getLong("generation") ?: -1L
        val title = call.getString("title")
        val text = call.getString("text")
        val url = call.getString("url")
        if (title.isNullOrBlank() || title.length > 1024 || text.isNullOrBlank() || text.length > 4096 ||
            url != null && !publicShare(url)) {
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
    private fun publicShare(value: String): Boolean {
        if (value.length > 8192) return false
        val uri = Uri.parse(value)
        if (uri.scheme != "https" || uri.host.isNullOrBlank() || uri.userInfo != null) return false
        if (uri.query == null && uri.fragment?.matches(Regex("^t=[A-Za-z0-9_-]{1,4096}$")) == true) return true
        return uri.fragment == null && uri.encodedPath?.endsWith("/live/") == true &&
            uri.queryParameterNames == setOf("session") && uri.getQueryParameters("session").size == 1 &&
            uri.getQueryParameter("session")?.matches(Regex("^[A-Za-z0-9_-]{12,64}$")) == true
    }
}
