package com.soundsible.player.ui

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import androidx.core.app.NotificationCompat
import com.soundsible.player.R

/**
 * Media notification for page (WebView) playback, which Media3 never sees.
 * Transport actions route back into the page through [LibraryActivity]
 * (single-top intents); tapping the body opens the library.
 */
object WebNowPlaying {
    const val ACTION_WEB_TOGGLE = "com.soundsible.player.ui.WEB_TOGGLE"
    const val ACTION_WEB_NEXT = "com.soundsible.player.ui.WEB_NEXT"
    const val ACTION_WEB_PREV = "com.soundsible.player.ui.WEB_PREV"

    private const val CHANNEL_ID = "soundsible-playing"
    private const val LEGACY_CHANNEL_ID = "soundsible-web-playing"
    private const val NOTIFICATION_ID = 42

    fun show(
        context: Context,
        title: String,
        artist: String,
        isPlaying: Boolean,
        artwork: Bitmap?,
    ) {
        val manager = context.getSystemService(NotificationManager::class.java)
        try {
            // Fresh channel: importance upgrades never apply to an existing
            // channel, and lockscreen presence wants DEFAULT, not LOW.
            manager.deleteNotificationChannel(LEGACY_CHANNEL_ID)
        } catch (_: Exception) {
        }
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Now playing", NotificationManager.IMPORTANCE_DEFAULT),
        )
        val open = PendingIntent.getActivity(
            context, 10,
            Intent(context, LibraryActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val collapsed = android.widget.RemoteViews(context.packageName, R.layout.notification_player).apply {
            if (artwork != null) {
                setViewVisibility(R.id.notifArtSmall, android.view.View.VISIBLE)
                setImageViewBitmap(R.id.notifArtSmall, artwork)
            } else {
                setViewVisibility(R.id.notifArtSmall, android.view.View.GONE)
            }
            setTextViewText(R.id.notifTitleSmall, title)
            setTextViewText(R.id.notifArtistSmall, artist)
            setImageViewResource(
                R.id.notifToggleSmall,
                if (isPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
            )
            setOnClickPendingIntent(R.id.notifToggleSmall, action(context, ACTION_WEB_TOGGLE, 12))
        }
        val expanded = android.widget.RemoteViews(context.packageName, R.layout.notification_player_big).apply {
            if (artwork != null) {
                setViewVisibility(R.id.notifArtBig, android.view.View.VISIBLE)
                setImageViewBitmap(R.id.notifArtBig, artwork)
            } else {
                setViewVisibility(R.id.notifArtBig, android.view.View.GONE)
            }
            setTextViewText(R.id.notifTitleBig, title)
            setTextViewText(R.id.notifArtistBig, artist)
            val toggleIcon =
                if (isPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play
            setImageViewResource(R.id.notifToggle, toggleIcon)
            setImageViewResource(R.id.notifPrev, android.R.drawable.ic_media_previous)
            setImageViewResource(R.id.notifNext, android.R.drawable.ic_media_next)
            setOnClickPendingIntent(R.id.notifPrev, action(context, ACTION_WEB_PREV, 11))
            setOnClickPendingIntent(R.id.notifToggle, action(context, ACTION_WEB_TOGGLE, 12))
            setOnClickPendingIntent(R.id.notifNext, action(context, ACTION_WEB_NEXT, 13))
        }
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(artist.ifEmpty { null })
            .setContentIntent(open)
            .setOngoing(isPlaying)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCustomContentView(collapsed)
            .setCustomBigContentView(expanded)
            .addAction(android.R.drawable.ic_media_previous, "Previous", action(context, ACTION_WEB_PREV, 11))
            .addAction(
                if (isPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                if (isPlaying) "Pause" else "Play",
                action(context, ACTION_WEB_TOGGLE, 12),
            )
            .addAction(android.R.drawable.ic_media_next, "Next", action(context, ACTION_WEB_NEXT, 13))
            .setStyle(
                // The media-decorated variant (not the plain decorated style):
                // custom black views with the platform media treatment.
                // System integration (lockscreen/car/BT) rides the separate
                // compat session, which publishes regardless of this view.
                androidx.media.app.NotificationCompat.DecoratedMediaCustomViewStyle()
                    .setShowActionsInCompactView(0, 1, 2),
            )
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
        manager.notify(NOTIFICATION_ID, notification)
    }

    fun cancel(context: Context) {
        try {
            context.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
        } catch (_: Exception) {
        }
    }

    private fun action(context: Context, what: String, requestCode: Int): PendingIntent {
        val intent = Intent(context, LibraryActivity::class.java)
            .setAction(what)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(
            context, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
