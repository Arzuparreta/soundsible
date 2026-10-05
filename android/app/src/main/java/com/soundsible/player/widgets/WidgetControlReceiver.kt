package com.soundsible.player.widgets

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.soundsible.player.ui.LibraryActivity
import com.soundsible.player.ui.WebAudio
import com.soundsible.player.ui.WebCommand
import com.soundsible.player.ui.WebNowPlaying

/**
 * Widget buttons drive the web player: straight into the live page when
 * attached, otherwise opening the library with the command pending. The
 * native controller path commanded an empty player while audio came from
 * the page, so taps silently did nothing.
 */
class WidgetControlReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        try {
            if (WebAudio.command(intent.action)) return
            val webAction = when (intent.action) {
                ACTION_TOGGLE -> WebNowPlaying.ACTION_WEB_TOGGLE
                ACTION_NEXT -> WebNowPlaying.ACTION_WEB_NEXT
                ACTION_PREV -> WebNowPlaying.ACTION_WEB_PREV
                else -> return
            }
            context.startActivity(
                Intent(context, LibraryActivity::class.java)
                    .setAction(webAction)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        } catch (_: Exception) {
        }
    }

    companion object {
        const val ACTION_TOGGLE = WebCommand.TOGGLE
        const val ACTION_NEXT = WebCommand.NEXT
        const val ACTION_PREV = WebCommand.PREV
    }
}
