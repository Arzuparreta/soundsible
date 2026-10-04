package com.soundsible.player.widgets

import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.soundsible.player.SoundsibleApp
import com.soundsible.player.playback.PlaybackService
import com.soundsible.player.playback.QueueHolder
import java.util.concurrent.TimeUnit

/**
 * Widget button handler. Connects a short-lived [MediaController] to the
 * playback session and issues one command, instead of routing media keys
 * through the system receiver (which killed the host process when the
 * session service was not already running).
 */
class WidgetControlReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        Thread({
            try {
                val app = context.applicationContext as SoundsibleApp
                val token = SessionToken(app, ComponentName(app, PlaybackService::class.java))
                val controller = MediaController.Builder(app, token)
                    .buildAsync()
                    .get(8, TimeUnit.SECONDS)
                try {
                    if (controller.mediaItemCount == 0) {
                        restoreQueue(app, controller)
                    }
                    if (controller.mediaItemCount > 0) {
                        when (intent.action) {
                            ACTION_TOGGLE -> {
                                if (controller.isPlaying) {
                                    controller.pause()
                                } else {
                                    controller.prepare()
                                    controller.play()
                                }
                            }
                            ACTION_NEXT -> controller.seekToNextMediaItem()
                            ACTION_PREV -> controller.seekToPreviousMediaItem()
                        }
                    }
                } finally {
                    controller.release()
                }
            } catch (_: Exception) {
            } finally {
                pending.finish()
            }
        }, "soundsible-widget-command").start()
    }

    private fun restoreQueue(app: SoundsibleApp, controller: MediaController) {
        try {
            val snapshot = app.queueStore.load() ?: return
            if (snapshot.items.isEmpty()) return
            QueueHolder.queue.restore(snapshot.items, snapshot.index)
            val items = snapshot.items.mapIndexed { index, item -> QueueHolder.mediaItem(item, index) }
            controller.setMediaItems(items, 0, snapshot.positionMs.coerceAtLeast(0L))
        } catch (_: Exception) {
        }
    }

    companion object {
        const val ACTION_TOGGLE = "com.soundsible.player.widgets.TOGGLE"
        const val ACTION_NEXT = "com.soundsible.player.widgets.NEXT"
        const val ACTION_PREV = "com.soundsible.player.widgets.PREV"
    }
}
