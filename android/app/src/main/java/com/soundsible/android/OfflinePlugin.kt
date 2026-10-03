package com.soundsible.android

import android.content.Intent
import androidx.core.content.ContextCompat
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject

@CapacitorPlugin(name="SoundsibleOffline")
class OfflinePlugin : Plugin() {
    private val executor = java.util.concurrent.Executors.newSingleThreadExecutor()
    @PluginMethod fun command(call: PluginCall) { executor.execute {
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
    } }
    override fun handleOnDestroy() { executor.shutdown() }
}
