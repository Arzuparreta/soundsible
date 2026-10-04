package com.soundsible.player.ui

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.soundsible.player.LocalEngine
import com.soundsible.player.R
import com.soundsible.player.SoundsibleApp
import com.soundsible.player.playback.EngineService
import com.soundsible.player.playback.QueueHolder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Splash router: with a stored connection, make sure its server answers
 * before showing the library. For the on-device engine that means (re)start
 * the foreground service and wait out the boot with a visible status --
 * reopening the app after Android killed it lands here, not on a dead page.
 */
class MainActivity : AppCompatActivity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            scope.launch { route(findViewById(R.id.splashStatus)) }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
                android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        } else {
            scope.launch {
                route(findViewById(R.id.splashStatus))
            }
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private suspend fun route(status: TextView) {
        val app = application as SoundsibleApp
        val connection = app.tokenStore.load()
        if (connection == null) {
            startActivity(Intent(this, PairingActivity::class.java))
            finish()
            return
        }
        if (connection.label != "This phone") {
            restoreQueue()
            openLibrary()
            return
        }
        // Local engine: the stored port/token die with every engine restart
        // (random port per boot, rotated owner token). Never trust them:
        // (re)start the service, then adopt whatever the ready engine
        // reports via its state file.
        withContext(Dispatchers.IO) {
            startForegroundService(Intent(this@MainActivity, EngineService::class.java))
        }
        repeat(100) {
            val fresh = withContext(Dispatchers.IO) { LocalEngine.localConnection() }
            if (fresh != null && withContext(Dispatchers.IO) { LocalEngine.isHealthy(fresh.baseUrl) }) {
                app.tokenStore.save(fresh)
                restoreQueue()
                openLibrary()
                return
            }
            val (phase, _) = LocalEngine.localStatus()
            status.text = "${getString(R.string.splash_starting)} ($phase…)"
            delay(1_000)
        }
        status.text = "The engine on this phone did not start. Reopen the app to retry."
    }

    private fun restoreQueue() {
        try {
            val snapshot = (application as SoundsibleApp).queueStore.load() ?: return
            QueueHolder.queue.restore(snapshot.items, snapshot.index)
            QueueHolder.pendingSeekMs = snapshot.positionMs.coerceAtLeast(0L)
        } catch (_: Exception) {
        }
    }

    private fun openLibrary() {
        startActivity(Intent(this, LibraryActivity::class.java))
        finish()
    }
}
