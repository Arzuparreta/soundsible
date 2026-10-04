package com.soundsible.player.store

import android.content.Context
import android.os.Build
import android.provider.Settings
import java.util.UUID

private const val KEY_DEVICE_ID = "device_id"
private const val KEY_DEVICE_NAME = "device_name"

/** Stable per-install device identity for `POST /api/devices/register`. */
class DeviceIdentity(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("soundsible_prefs", Context.MODE_PRIVATE)

    val deviceId: String
        get() {
            var id = prefs.getString(KEY_DEVICE_ID, null)
            if (id.isNullOrEmpty()) {
                id = UUID.randomUUID().toString()
                prefs.edit().putString(KEY_DEVICE_ID, id).apply()
            }
            return id!!
        }

    val deviceName: String
        get() {
            var name = prefs.getString(KEY_DEVICE_NAME, null)
            if (name.isNullOrEmpty()) {
                val androidId = try {
                    Settings.Secure.getString(
                        context.applicationContext.contentResolver,
                        Settings.Secure.ANDROID_ID,
                    )
                } catch (_: Exception) {
                    null
                }
                name = "Android ${Build.MODEL ?: "device"}${if (!androidId.isNullOrEmpty()) " $androidId".take(12) else ""}".trim()
                prefs.edit().putString(KEY_DEVICE_NAME, name).apply()
            }
            return name!!
        }

    private val context: Context = context.applicationContext
}
