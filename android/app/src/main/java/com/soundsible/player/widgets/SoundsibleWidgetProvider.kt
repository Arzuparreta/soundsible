package com.soundsible.player.widgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import com.soundsible.player.R
import com.soundsible.player.playback.QueueHolder
import com.soundsible.player.ui.MainActivity

/**
 * Home-screen player widget: artwork, title/artist, previous/play/next.
 * Album backdrop follows the cover's dominant color; transport runs into
 * the page through [WidgetControlReceiver]. Needs no controller connection
 * and no notification permission.
 */
class SoundsibleWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val current = QueueHolder.queue.current
        for (id in ids) {
            manager.updateAppWidget(
                id,
                views(
                    context,
                    current?.title ?: context.getString(R.string.app_name),
                    current?.subtitle?.ifEmpty { current?.artist } ?: "",
                    isPlaying = false,
                    artwork = null,
                    background = lastBackground,
                ),
            )
        }
    }

    companion object {
        @Volatile private var lastBackground: Int? = null

        fun updateAll(
            context: Context,
            title: String,
            subtitle: String,
            isPlaying: Boolean,
            artwork: android.graphics.Bitmap? = null,
            background: Int? = null,
        ) {
            if (background != null) lastBackground = background
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, SoundsibleWidgetProvider::class.java))
            if (ids.isEmpty()) return
            for (id in ids) {
                manager.updateAppWidget(id, views(context, title, subtitle, isPlaying, artwork, background ?: lastBackground))
            }
        }

        private fun views(
            context: Context,
            title: String,
            subtitle: String,
            isPlaying: Boolean,
            artwork: android.graphics.Bitmap?,
            background: Int?,
        ): android.widget.RemoteViews {
            return android.widget.RemoteViews(context.packageName, R.layout.widget_player).apply {
                if (background != null) {
                    setInt(R.id.widgetRoot, "setBackgroundColor", background)
                }
                setTextViewText(R.id.widgetTitle, title)
                setTextViewText(R.id.widgetSubtitle, subtitle.ifEmpty { context.getString(R.string.now_playing) })
                if (artwork != null) {
                    setViewVisibility(R.id.widgetArt, android.view.View.VISIBLE)
                    setImageViewBitmap(R.id.widgetArt, artwork)
                } else {
                    // No thumbnail: the app mark stands in over the backdrop.
                    setViewVisibility(R.id.widgetArt, android.view.View.VISIBLE)
                    setImageViewResource(R.id.widgetArt, R.drawable.soundsible_logo)
                }
                setImageViewResource(
                    R.id.widgetPlayPause,
                    if (isPlaying) R.drawable.ic_pause_circle else R.drawable.ic_play_circle,
                )
                val open = PendingIntent.getActivity(
                    context, 20,
                    Intent(context, MainActivity::class.java),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                setOnClickPendingIntent(R.id.widgetTitle, open)
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
