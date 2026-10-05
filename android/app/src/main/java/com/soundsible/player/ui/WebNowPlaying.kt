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

    @Volatile private var permissionToastShown = false

    fun show(
        context: Context,
        title: String,
        artist: String,
        isPlaying: Boolean,
        artwork: Bitmap?,
        background: Int? = null,
        mediaSession: android.support.v4.media.session.MediaSessionCompat.Token? = null,
    ) {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (!manager.areNotificationsEnabled()) {
            // The system drops everything below this point silently. Say so
            // once, visibly: a toast needs no permission.
            android.util.Log.w("SoundsiblePlaying", "notifications disabled; skipping media post")
            if (!permissionToastShown) {
                permissionToastShown = true
                try {
                    android.os.Handler(android.os.Looper.getMainLooper()).post {
                        try {
                            android.widget.Toast.makeText(
                                context.applicationContext,
                                "Enable notifications for playback controls",
                                android.widget.Toast.LENGTH_LONG,
                            ).show()
                        } catch (_: Exception) {
                        }
                    }
                } catch (_: Exception) {
                }
            }
            return
        }
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
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val mediaStyle = androidx.media.app.NotificationCompat.MediaStyle()
        mediaStyle.setShowActionsInCompactView(0, 1, 2)
        if (mediaSession != null) {
            mediaStyle.setMediaSession(mediaSession)
        }
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(artist.ifEmpty { null })
            .setSubText(context.getString(R.string.app_name))
            .setLargeIcon(artwork)
            .setContentIntent(open)
            .setOngoing(isPlaying)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .apply {
                // The media template owns the background; the accent is ours.
                if (background != null) setColor(background)
            }
            .addAction(android.R.drawable.ic_media_previous, "Previous", action(context, ACTION_WEB_PREV, 11))
            .addAction(
                if (isPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                if (isPlaying) "Pause" else "Play",
                action(context, ACTION_WEB_TOGGLE, 12),
            )
            .addAction(android.R.drawable.ic_media_next, "Next", action(context, ACTION_WEB_NEXT, 13))
            .setStyle(mediaStyle)
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
        val intent = Intent(context, MainActivity::class.java)
            .setAction(what)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(
            context, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
