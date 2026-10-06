package com.soundsible.android

import android.content.Intent
import androidx.core.content.ContextCompat
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import org.json.JSONObject

@CapacitorPlugin(name="SoundsibleOffline", permissions = [Permission(alias = "notifications", strings = ["android.permission.POST_NOTIFICATIONS"])])
class OfflinePlugin : Plugin() {
    private val executor = java.util.concurrent.Executors.newSingleThreadExecutor()
    @Volatile private var closed = false
    @PluginMethod fun command(call: PluginCall) {
        if (closed) { unavailable(call); return }
        activity.runOnUiThread {
            if (closed) { unavailable(call); return@runOnUiThread }
            val prefs = context.getSharedPreferences("soundsible-notifications", android.content.Context.MODE_PRIVATE)
            if (call.getString("action") == "prepare" && android.os.Build.VERSION.SDK_INT >= 33 &&
                getPermissionState("notifications") != PermissionState.GRANTED && !prefs.getBoolean("asked", false)) {
                if (call.getInt("generation")?.toLong() != EngineConnection.shared(context).generation) {
                    call.reject("Account changed.", "OFFLINE_FAILED"); return@runOnUiThread
                }
                prefs.edit().putBoolean("asked", true).apply()
                requestPermissionForAlias("notifications", call, "notificationsAnswered")
            } else execute(call)
        }
    }
    // Grant or denial only changes notification visibility, never the copy operation.
    @PermissionCallback private fun notificationsAnswered(call: PluginCall) { execute(call) }
    private fun unavailable(call: PluginCall) { call.reject("Offline bridge closed.", "OFFLINE_FAILED") }
    private fun execute(call: PluginCall) {
        if (closed) { unavailable(call); return }
        try {
            executor.execute work@{
                if (closed) { unavailable(call); return@work }
                try {
                    val store=OfflineStore.shared(context)
                    val epoch=call.getInt("generation")?.toLong() ?: -1L
                    if (BuildConfig.DEBUG && call.getString("action") != "state") android.util.Log.d("OfflineCommand", call.getString("action") ?: "unknown")
                    when(call.getString("action")) {
                        "prepare" -> {
                            store.prepare(epoch,call.getArray("tracks") ?: error("tracks"),call.getObject("playlists") ?: JSONObject())
                            try { ContextCompat.startForegroundService(context,Intent(context,OfflineService::class.java)) }
                            catch (error: Exception) { store.interrupt(); throw error }
                        }
                        "remove" -> store.remove(epoch,call.getArray("ids") ?: error("ids"))
                        "limit" -> store.limit(epoch,call.getDouble("bytes")?.toLong() ?: 0)
                        "state" -> {}
                        else -> error("action")
                    }
                    call.resolve(JSObject(store.state(epoch).toString()))
                } catch (error:Exception) { if(BuildConfig.DEBUG) android.util.Log.d("OfflineCommand", "Failed: " + error.message); call.reject("Offline operation failed or account changed.","OFFLINE_FAILED") }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) { unavailable(call) }
    }
    override fun handleOnDestroy() { closed = true; executor.shutdown() }
}
