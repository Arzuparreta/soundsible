package com.soundsible.android

import android.app.Service
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat

/** Started only by an explicit foreground menu action, stops once its queue is terminal. */
class OfflineService : Service() {
    private val main = android.os.Handler(android.os.Looper.getMainLooper())
    private fun drain() { OfflineStore.shared(this).run { main.post { if(OfflineStore.shared(this).idle()) stopSelf() else drain() } } }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val manager = getSystemService(NotificationManager::class.java)
        if (android.os.Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel("offline", getString(R.string.offline_title), NotificationManager.IMPORTANCE_LOW))
        val activity = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        startForeground(102, NotificationCompat.Builder(this, "offline").setSmallIcon(R.drawable.ic_launcher).setContentTitle(getString(R.string.offline_title)).setContentText(getString(R.string.offline_preparing)).setContentIntent(activity).setOngoing(true).build())
        drain()
        return START_NOT_STICKY
    }
    override fun onTimeout(startId: Int, fgsType: Int) { OfflineStore.shared(this).interrupt(); stopSelf() }
    override fun onDestroy() { main.removeCallbacksAndMessages(null); if(OfflineStore.shared(this).active()) OfflineStore.shared(this).interrupt(); super.onDestroy() }
}
