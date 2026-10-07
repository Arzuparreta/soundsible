package com.soundsible.android

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.PersistableBundle
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/** Explicit copy without reads, persistence, diagnostics or credential previews. */
@CapacitorPlugin(name = "SoundsibleClipboard")
class ClipboardPlugin : Plugin() {
    @PluginMethod fun write(call: PluginCall) {
        val epoch = call.getInt("generation")?.toLong() ?: call.getLong("generation") ?: -1L
        val text = call.getString("text")
        val sensitive = call.getBoolean("sensitive")
        if (text.isNullOrEmpty() || text.length > 4096 || sensitive == null) {
            call.reject("A supported copy value is required.", "INVALID_COPY"); return
        }
        val connection = EngineConnection.shared(context)
        val session = runCatching { connection.sessionIdentity(epoch) }.getOrNull()
        if (session == null) { call.reject("Sign in again before copying.", "COPY_SESSION_CHANGED"); return }
        activity.runOnUiThread {
            if (activity.isFinishing || !bridge.webView.hasWindowFocus() ||
                epoch != connection.generation || runCatching { connection.sessionIdentity(epoch) }.getOrNull() != session) {
                call.reject("Copy session is no longer active.", "COPY_SESSION_CHANGED"); return@runOnUiThread
            }
            try {
                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                val clip = ClipData.newPlainText("Soundsible", text)
                clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, sensitive) }
                clipboard.setPrimaryClip(clip)
                call.resolve(JSObject().put("copied", true))
            } catch (_: Exception) {
                call.reject("The system clipboard is unavailable.", "COPY_UNAVAILABLE")
            }
        }
    }
}
