package com.soundsible.player.ui

import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import java.lang.ref.WeakReference

/**
 * Pauses page audio when the native player takes over, so the phone never
 * sounds from two players at once. The page exposes the hook itself
 * (`window.SoundsibleNativeControl.pause`); calls are no-ops without it.
 */
object WebAudio {
    private var viewRef: WeakReference<WebView>? = null
    private val main = Handler(Looper.getMainLooper())

    fun attach(view: WebView) {
        viewRef = WeakReference(view)
    }

    fun detach(view: WebView) {
        if (viewRef?.get() === view) viewRef = null
    }

    /** Pause page audio if the page offers the hook. Never throws. */
    fun pause() {
        val view = viewRef?.get() ?: return
        main.post {
            try {
                view.evaluateJavascript(
                    "(function(){var c=window.SoundsibleNativeControl;if(c&&c.pause){c.pause();}})()",
                    null,
                )
            } catch (_: Exception) {
            }
        }
    }
}
