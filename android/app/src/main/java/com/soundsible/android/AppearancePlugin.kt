package com.soundsible.android

import android.graphics.Color
import android.os.Build
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/** Only document appearance crosses this bridge; no engine or playback state. */
@CapacitorPlugin(name = "SoundsibleAppearance")
class AppearancePlugin : Plugin() {
    @PluginMethod fun apply(call: PluginCall) {
        val color = call.getString("color")
        if (color == null || !Regex("^#[0-9a-fA-F]{6}$").matches(color)) {
            call.reject("A palette color is required.", "INVALID_APPEARANCE")
            return
        }
        activity.runOnUiThread {
            val window = activity.window
            val background = Color.parseColor(color)
            window.decorView.setBackgroundColor(background)
            bridge.webView.setBackgroundColor(background)
            // Android 15+ enforces transparent bars; the decor paints beneath them.
            if (Build.VERSION.SDK_INT < 35) {
                @Suppress("DEPRECATION")
                window.statusBarColor = background
                @Suppress("DEPRECATION")
                window.navigationBarColor = background
            }
            call.resolve()
        }
    }
}
