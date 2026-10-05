package com.soundsible.android

import android.view.HapticFeedbackConstants
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/** View feedback follows Android's preferences; it does not need vibration permission. */
@CapacitorPlugin(name = "SoundsibleFeedback")
class FeedbackPlugin : Plugin() {
    @PluginMethod fun pulse(call: PluginCall) {
        val effect = when (call.getString("kind")) {
            "tap" -> HapticFeedbackConstants.VIRTUAL_KEY
            "hold" -> HapticFeedbackConstants.LONG_PRESS
            else -> { call.reject("A supported feedback kind is required.", "INVALID_FEEDBACK"); return }
        }
        activity.runOnUiThread {
            // No flags bypass system settings or the view's own feedback preference.
            val accepted = bridge.webView.performHapticFeedback(effect)
            call.resolve(com.getcapacitor.JSObject().put("accepted", accepted))
        }
    }
}
