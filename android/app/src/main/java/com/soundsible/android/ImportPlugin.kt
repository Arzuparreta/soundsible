package com.soundsible.android

import android.app.Activity
import android.content.Intent
import android.os.CancellationSignal
import android.provider.OpenableColumns
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Select one export with an OS content grant; never expose its URI to JavaScript. */
@CapacitorPlugin(name = "SoundsibleImport")
class ImportPlugin : Plugin() {
    private var picker: PluginCall? = null
    private var pickerProfile: String? = null
    private var pickerSession: String? = null
    private var query: CancellationSignal? = null
    private var deadline: java.util.concurrent.ScheduledFuture<*>? = null
    // Providers may do IO in metadata queries. Never block the Activity; bound
    // workers/queue even if a broken provider ignores cancellation.
    private val reader = ThreadPoolExecutor(2, 2, 0, TimeUnit.MILLISECONDS, ArrayBlockingQueue<Runnable>(2))
    private val clock = ScheduledThreadPoolExecutor(1).apply { removeOnCancelPolicy = true }
    private fun epoch(call: PluginCall) = call.getInt("generation")?.toLong() ?: call.getLong("generation") ?: -1L
    private fun clearLocked() { picker = null; pickerProfile = null; pickerSession = null; query = null; deadline?.cancel(false); deadline = null }
    private fun cancelSelection(id: String?, code: String) {
        val pending = synchronized(this) {
            val active = picker
            if (active == null || (id != null && active.getString("id") != id)) return
            val signal = query; clearLocked(); active to signal
        }
        runCatching { pending.second?.cancel() }
        pending.first.reject("Export selection cancelled.", code)
    }
    @PluginMethod fun select(call: PluginCall) {
        val connection = EngineConnection.shared(context)
        val epoch = epoch(call)
        val profile = runCatching { connection.offline.profileKey(epoch) }.getOrNull()
        val session = runCatching { connection.sessionIdentity(epoch) }.getOrNull()
        if (epoch != connection.generation || profile == null || session == null) { call.reject("Sign in again before importing.", "IMPORT_SESSION_CHANGED"); return }
        synchronized(this) {
            if (picker != null) { call.reject("An export picker is already open.", "IMPORT_BUSY"); return }
            picker = call; pickerProfile = profile; pickerSession = session
        }
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        // Document providers use different MIME names for CSV/XML/plist exports.
        // The production parser validates actual bytes and supported extensions.
        intent.putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/*", "text/*"))
        try { startActivityForResult(call, intent, "selected") }
        catch (_: Exception) { cancelSelection(call.getString("id"), "IMPORT_PICKER_FAILED") }
    }
    @ActivityCallback private fun selected(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val selection = synchronized(this) {
            if (call !== picker) return
            if (result.resultCode != Activity.RESULT_OK) { clearLocked(); call.resolve(JSObject().put("cancelled", true)); return }
            val signal = CancellationSignal(); query = signal
            deadline = clock.schedule({ cancelSelection(call.getString("id"), "IMPORT_FILE_TIMEOUT") }, 120, TimeUnit.SECONDS)
            Triple(pickerProfile, pickerSession, signal)
        }
        try {
            reader.execute {
                var token: String? = null
                try {
                    val connection = EngineConnection.shared(context)
                    val epoch = epoch(call)
                    val (profile, session, signal) = selection
                    signal.throwIfCanceled()
                    require(epoch == connection.generation && profile != null && profile == connection.offline.profileKey(epoch) && session != null && session == connection.sessionIdentity(epoch))
                    val uri = result.data?.data ?: result.data?.clipData?.takeIf { it.itemCount == 1 }?.getItemAt(0)?.uri ?: error("IMPORT_UNAVAILABLE")
                    require(uri.scheme == "content")
                    var name = ""; var size = -1L
                    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null, signal)?.use { row ->
                        if (row.moveToFirst()) {
                            val nameColumn = row.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                            if (nameColumn >= 0) name = row.getString(nameColumn) ?: ""
                            val sizeColumn = row.getColumnIndex(OpenableColumns.SIZE)
                            if (sizeColumn >= 0 && !row.isNull(sizeColumn)) size = row.getLong(sizeColumn)
                        }
                    }
                    signal.throwIfCanceled()
                    require(name.isNotBlank() && name.length <= 1024 && !name.contains('\n') && !name.contains('\r'))
                    val type = context.contentResolver.getType(uri) ?: "application/octet-stream"
                    signal.throwIfCanceled()
                    val selectedToken = java.util.UUID.randomUUID().toString(); token = selectedToken
                    ImportFiles.add(connection, ImportFiles.Source(selectedToken, epoch, profile, session, name, type, size, context.applicationContext, uri))
                    synchronized(this) {
                        if (picker !== call || query !== signal || signal.isCanceled) { ImportFiles.release(selectedToken); return@execute }
                        clearLocked()
                        call.resolve(JSObject().put("token", selectedToken).put("name", name).put("type", type).put("size", size))
                    }
                } catch (_: Exception) {
                    token?.let(ImportFiles::release)
                    synchronized(this) { if (picker === call) { clearLocked(); call.reject("Could not read the selected export file.", "IMPORT_FILE_FAILED") } }
                }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) { cancelSelection(call.getString("id"), "IMPORT_BUSY") }
    }
    @PluginMethod fun cancel(call: PluginCall) { cancelSelection(call.getString("id"), "IMPORT_CANCELLED"); call.resolve() }
    override fun handleOnDestroy() { cancelSelection(null, "IMPORT_CANCELLED"); reader.shutdownNow(); clock.shutdownNow() }
    @PluginMethod fun release(call: PluginCall) { call.getString("token")?.let(ImportFiles::release); call.resolve() }
}
