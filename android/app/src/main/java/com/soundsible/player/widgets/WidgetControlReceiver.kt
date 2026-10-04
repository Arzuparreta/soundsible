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
                        restoreAndDispatch(app, controller, intent.action)
                    } else {
                        dispatch(controller, intent.action)
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

    private fun dispatch(controller: MediaController, action: String?) {
        try {
            // Widget commands are native playback: the page yields first.
            try {
                com.soundsible.player.ui.WebAudio.pause()
            } catch (_: Exception) {
            }
            when (action) {
                ACTION_TOGGLE -> {
                    if (controller.isPlaying) {
                        controller.pause()
                    } else {
                        ensurePlaying(controller)
                    }
                }
                ACTION_NEXT -> {
                    controller.seekToNextMediaItem()
                    ensurePlaying(controller)
                }
                ACTION_PREV -> {
                    controller.seekToPreviousMediaItem()
                    ensurePlaying(controller)
                }
            }
        } catch (_: Exception) {
        }
    }

    private fun ensurePlaying(controller: MediaController) {
        try {
            if (controller.mediaItemCount == 0) return
            if (!controller.isPlaying) {
                controller.prepare()
                controller.play()
            }
        } catch (_: Exception) {
        }
    }

    private fun restoreAndDispatch(app: SoundsibleApp, controller: MediaController, action: String?) {
        try {
            val snapshot = app.queueStore.load()
            if (snapshot == null || snapshot.items.isEmpty()) return
            QueueHolder.queue.restore(snapshot.items, snapshot.index)
            val items = snapshot.items.mapIndexed { index, item -> QueueHolder.mediaItem(item, index) }
            // setMediaItems is fire-and-forget: wait for the first non-empty
            // timeline before commanding, then wait for it so release()
            // cannot cancel the command.
            val done = java.util.concurrent.CountDownLatch(1)
            val listener = object : androidx.media3.common.Player.Listener {
                override fun onTimelineChanged(timeline: androidx.media3.common.Timeline, reason: Int) {
                    if (timeline.isEmpty) return
                    try {
                        controller.removeListener(this)
                    } catch (_: Exception) {
                    }
                    try {
                        dispatch(controller, action)
                    } finally {
                        done.countDown()
                    }
                }
            }
            controller.addListener(listener)
            try {
                controller.setMediaItems(items, 0, snapshot.positionMs.coerceAtLeast(0L))
            } catch (_: Exception) {
                done.countDown()
            }
            done.await(10, TimeUnit.SECONDS)
        } catch (_: Exception) {
        }
    }

    companion object {
        const val ACTION_TOGGLE = "com.soundsible.player.widgets.TOGGLE"
        const val ACTION_NEXT = "com.soundsible.player.widgets.NEXT"
        const val ACTION_PREV = "com.soundsible.player.widgets.PREV"
    }
}
