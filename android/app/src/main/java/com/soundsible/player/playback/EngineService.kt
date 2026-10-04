package com.soundsible.player.playback

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.IBinder
import com.chaquo.python.Python
import com.soundsible.player.LocalEngine
import com.soundsible.player.R
import java.io.File

private const val CHANNEL_ID = "soundsible-engine"
private const val NOTIFICATION_ID = 41

/**
 * Keeps the on-device engine alive past the UI.
 *
 * Android kills background processes; a foreground service (with its
 * persistent notification) is what lets the loopback server survive after
 * the activities are swiped away. Playback has its own service;
 * this one owns the Python engine thread.
 */
class EngineService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.engine_service_channel),
            NotificationManager.IMPORTANCE_LOW,
        )
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.engine_service_title))
            .setContentText(getString(R.string.engine_service_text))
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .build()
        startForeground(NOTIFICATION_ID, notification)
        Thread({
            try {
                val root = File(filesDir, "soundsible")
                if (Python.isStarted()) {
                    val mod = Python.getInstance().getModule("soundsible_android")
                    mod.callAttr(
                        "configure",
                        File(root, "config").absolutePath,
                        File(root, "data").absolutePath,
                        File(root, "cache").absolutePath,
                        File(root, "log").absolutePath,
                        File(root, "music").absolutePath,
                        File(root, "ui").absolutePath,
                    )
                    File(root, "ui").mkdirs()
                    LocalEngine.installWebUi(assets, File(root, "ui"))
                    mod.callAttr("start")
                }
            } catch (_: Exception) {
                stopSelf()
            }
        }, "soundsible-engine-service").start()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onDestroy() {
        try {
            if (Python.isStarted()) {
                Python.getInstance().getModule("soundsible_android").callAttr("stop")
            }
        } catch (_: Exception) {
        }
        super.onDestroy()
    }
}
