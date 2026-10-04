package com.soundsible.player.widgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
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
        fun updateAll(
            context: Context,
            title: String,
            subtitle: String,
            isPlaying: Boolean,
            artwork: android.graphics.Bitmap? = null,
        ) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, SoundsibleWidgetProvider::class.java))
            if (ids.isEmpty()) return
            for (id in ids) {
                manager.updateAppWidget(id, views(context, title, subtitle, isPlaying, artwork))
            }
        }

        private fun views(
            context: Context,
            title: String,
            subtitle: String,
            isPlaying: Boolean,
            artwork: android.graphics.Bitmap?,
        ): android.widget.RemoteViews {
            return android.widget.RemoteViews(context.packageName, R.layout.widget_player).apply {
                setTextViewText(R.id.widgetTitle, title)
                setTextViewText(R.id.widgetSubtitle, subtitle.ifEmpty { context.getString(R.string.now_playing) })
                if (artwork != null) {
                    setImageViewBitmap(R.id.widgetArt, artwork)
                } else {
                    setImageViewResource(R.id.widgetArt, R.mipmap.ic_launcher)
                }
                setImageViewResource(
                    R.id.widgetPlayPause,
                    if (isPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                )
                setOnClickPendingIntent(R.id.widgetPrev, command(context, WidgetControlReceiver.ACTION_PREV, 1))
                setOnClickPendingIntent(R.id.widgetPlayPause, command(context, WidgetControlReceiver.ACTION_TOGGLE, 2))
                setOnClickPendingIntent(R.id.widgetNext, command(context, WidgetControlReceiver.ACTION_NEXT, 3))
            }
        }

        private fun command(context: Context, action: String, requestCode: Int): PendingIntent {
            val intent = Intent(context, WidgetControlReceiver::class.java).setAction(action)
            return PendingIntent.getBroadcast(context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
    }
}
