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
import com.soundsible.player.store.LastSongPin
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
    private val waveAnimators = mutableListOf<android.animation.ObjectAnimator>()
    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            scope.launch { route(findViewById(R.id.splashStatus)) }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        startWaves()
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
        waveAnimators.forEach {
            try {
                it.cancel()
            } catch (_: Exception) {
            }
        }
        waveAnimators.clear()
        scope.cancel()
        super.onDestroy()
    }

    /** Five-bar EQ loop mirroring the web boot screen's startup-waves. */
    private fun startWaves() {
        val ids = listOf(R.id.wave0, R.id.wave1, R.id.wave2, R.id.wave3, R.id.wave4)
        val delays = listOf(0L, 460L, 820L, 250L, 670L)
        ids.forEachIndexed { i, id ->
            val bar = findViewById<android.view.View>(id) ?: return@forEachIndexed
            bar.scaleY = 0.3f
            val animator = android.animation.ObjectAnimator.ofFloat(bar, "scaleY", 0.3f, 1f).apply {
                duration = 1100L
                startDelay = delays[i]
                repeatCount = android.animation.ValueAnimator.INFINITE
                repeatMode = android.animation.ValueAnimator.REVERSE
            }
            waveAnimators += animator
            animator.start()
        }
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
            val app = application as SoundsibleApp
            val snapshot = app.queueStore.load()
            if (snapshot != null && snapshot.items.isNotEmpty()) {
                // Prefer the pinned bytes for the current track: they survive
                // eviction, updates and offline stretches alike.
                val pin = LastSongPin.load(this)
                val items = snapshot.items.map { item ->
                    val id = item.effectiveTrackId() ?: item.id
                    if (pin != null && id == pin.trackId) {
                        item.copy(streamUrl = pin.file.toURI().toString())
                    } else {
                        item
                    }
                }
                QueueHolder.queue.restore(items, snapshot.index)
                QueueHolder.pendingSeekMs = snapshot.positionMs.coerceAtLeast(0L)
                return
            }
            // No snapshot at all, but a pinned song: resume it alone.
            val pin = LastSongPin.load(this)
            if (pin != null) {
                QueueHolder.queue.restore(listOf(pin.toItem()), 0)
                QueueHolder.pendingSeekMs = 0L
            }
        } catch (_: Exception) {
        }
    }

    private fun openLibrary() {
        startActivity(Intent(this, LibraryActivity::class.java))
        finish()
    }
}
