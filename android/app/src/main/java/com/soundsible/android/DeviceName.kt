package com.soundsible.android

import android.content.Context

/** This install's name for other devices: the user's choice, else what the phone calls itself, else its model. */
internal object DeviceName {
    private const val KEY = "device_name"
    private fun prefs(context: Context) = context.getSharedPreferences("soundsible-device", Context.MODE_PRIVATE)
    fun valid(value: String): Boolean = value.length in 1..64 && value.none { it.isISOControl() }
    fun get(context: Context): String = prefs(context).getString(KEY, null)?.takeIf(::valid) ?: system(context)
    fun set(context: Context, value: String): Boolean {
        val next = value.trim()
        if (!valid(next)) return false
        prefs(context).edit().putString(KEY, next).apply(); return true
    }
    private fun system(context: Context): String =
        runCatching { android.provider.Settings.Global.getString(context.contentResolver, "device_name") }.getOrNull()?.trim()?.takeIf(::valid)
            ?: android.os.Build.MODEL?.trim()?.takeIf(::valid) ?: "Soundsible Android"
}
