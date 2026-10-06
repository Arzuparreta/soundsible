package com.soundsible.android

import android.content.Context
import android.content.Intent
import android.net.Uri
import com.getcapacitor.JSObject

/** One explicit incoming public song link; never connection settings, account data or an autoplay command. */
internal object IncomingTrackState {
    private const val PREFS = "soundsible-incoming-track"
    @Synchronized fun pending(context: Context): JSObject? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val url = prefs.getString("url", null) ?: return null
        val token = prefs.getString("token", null) ?: return null
        return JSObject().put("url", url).put("token", token)
    }
    @Synchronized fun dismiss(context: Context, token: String): Boolean {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getString("token", null) != token) return false
        prefs.edit().clear().apply(); return true
    }
    @Synchronized fun accept(context: Context, intent: Intent): JSObject? {
        val candidates = when (intent.action) {
            Intent.ACTION_VIEW -> listOfNotNull(intent.data?.toString())
            Intent.ACTION_SEND -> {
                if (intent.type != "text/plain") return null
                val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString() ?: return null
                if (text.length > 8192) return null
                text.lineSequence().map(String::trim).filter { supported(it) }.toList()
            }
            else -> return null
        }.filter { supported(it) }
        if (candidates.size != 1) return null
        val token = java.util.UUID.randomUUID().toString()
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("url", candidates.single()).putString("token", token).apply()
        return pending(context)
    }
    /** An engine invitation link (`<origin>/player/#/invite/<token>`), shared as text; accepting it is a later explicit step. */
    private fun invitation(uri: Uri): Boolean =
        uri.scheme in listOf("http", "https") && !uri.host.isNullOrBlank() && uri.query == null &&
            uri.encodedPath == "/player/" && uri.fragment?.matches(Regex("^/invite/[A-Za-z0-9_-]{16,128}$")) == true
    private fun supported(value: String): Boolean = runCatching {
        if (value.length > 8192) return false
        val uri = Uri.parse(value)
        if (uri.userInfo != null) return false
        val encoded = if (uri.scheme == "soundsible" && uri.host == "open" && uri.path.isNullOrEmpty() && uri.fragment == null &&
            uri.queryParameterNames == setOf("shared") && uri.getQueryParameters("shared").size == 1) uri.getQueryParameter("shared")
        else if (uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.query == null && uri.fragment?.startsWith("t=") == true) uri.fragment!!.substring(2)
        else null
        encoded?.matches(Regex("^[A-Za-z0-9_-]{1,4096}$")) == true || invitation(uri)
    }.getOrDefault(false)
}
