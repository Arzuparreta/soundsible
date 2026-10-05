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
        command(WebCommand.PAUSE)
    }

    /**
     * Run a page transport command. Returns false when no page is attached,
     * so callers can fall back to opening the library first.
     */
    fun command(action: String?): Boolean {
        val fn = when (action) {
            WebCommand.TOGGLE -> "toggle()"
            WebCommand.NEXT -> "next()"
            WebCommand.PREV -> "previous()"
            WebCommand.PAUSE -> "pause()"
            else -> return false
        }
        val view = viewRef?.get() ?: return false
        main.post {
            try {
                view.evaluateJavascript(
                    "(function(){var c=window.SoundsibleNativeControl;if(c&&c.$fn){c.$fn();}})()",
                    null,
                )
            } catch (_: Exception) {
            }
        }
        return true
    }
}
