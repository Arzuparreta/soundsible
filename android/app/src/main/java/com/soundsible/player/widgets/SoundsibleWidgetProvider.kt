package com.soundsible.player.widgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.view.KeyEvent
import androidx.media3.session.MediaButtonReceiver
import com.soundsible.player.R
import com.soundsible.player.playback.QueueHolder

/**
 * Home-screen player widget: title, play/pause, previous, next.
 *
 * Buttons send media keys straight to the playback session through
 * [MediaButtonReceiver], so the widget needs no controller connection and
 * no notification permission. [PlaybackService] pushes fresh title/state
 * on every playback change; [onUpdate] covers placement and reboot.
 */
class SoundsibleWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val current = QueueHolder.queue.current
        updateAll(
            context,
            title = current?.title ?: context.getString(R.string.app_name),
            subtitle = current?.subtitle?.ifEmpty { current?.artist } ?: "",
            isPlaying = false,
        )
    }

    companion object {
        fun updateAll(context: Context, title: String, subtitle: String, isPlaying: Boolean) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, SoundsibleWidgetProvider::class.java))
            if (ids.isEmpty()) return
            for (id in ids) {
                manager.updateAppWidget(id, views(context, title, subtitle, isPlaying))
            }
        }

        private fun views(
            context: Context,
            title: String,
            subtitle: String,
            isPlaying: Boolean,
        ): android.widget.RemoteViews {
            return android.widget.RemoteViews(context.packageName, R.layout.widget_player).apply {
                setTextViewText(R.id.widgetTitle, title)
                setTextViewText(R.id.widgetSubtitle, subtitle.ifEmpty { context.getString(R.string.now_playing) })
                setImageViewResource(
                    R.id.widgetPlayPause,
                    if (isPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                )
                setOnClickPendingIntent(R.id.widgetPrev, mediaKey(context, KeyEvent.KEYCODE_MEDIA_PREVIOUS, 1))
                setOnClickPendingIntent(R.id.widgetPlayPause, mediaKey(context, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, 2))
                setOnClickPendingIntent(R.id.widgetNext, mediaKey(context, KeyEvent.KEYCODE_MEDIA_NEXT, 3))
            }
        }

        private fun mediaKey(context: Context, keyCode: Int, requestCode: Int): PendingIntent {
            val down = Intent(Intent.ACTION_MEDIA_BUTTON, null, context, MediaButtonReceiver::class.java)
                .putExtra(Intent.EXTRA_KEY_EVENT, KeyEvent(KeyEvent.ACTION_DOWN, keyCode))
            return PendingIntent.getBroadcast(context, requestCode, down, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
    }
}
