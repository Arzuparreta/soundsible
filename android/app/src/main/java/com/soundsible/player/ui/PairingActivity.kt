package com.soundsible.player.ui

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import com.chaquo.python.android.AndroidPlatform
import com.soundsible.player.LocalEngine
import com.soundsible.player.R
import com.soundsible.player.SoundsibleApp
import com.soundsible.player.net.PairingCoordinator
import com.soundsible.player.net.PairingOutcome
import com.soundsible.player.net.SoundsibleError
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Pairing screen. Mirrors the iOS PairingView: claim a visible code when the
 * server sheet is open (auto-confirm), or paste a device token for headless
 * servers. QR scanning is not in v1 -- manual entry is the whole flow.
 */
class PairingActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_pairing)

        val serverUrl = findViewById<EditText>(R.id.serverUrl)
        val pairingCode = findViewById<EditText>(R.id.pairingCode)
        val deviceToken = findViewById<EditText>(R.id.deviceToken)
        val status = findViewById<TextView>(R.id.pairingStatus)
        refreshEngineStatus()
        // Boot runs on a background thread and may finish after this screen
        // appears; tapping the line retries a failed boot.
        findViewById<TextView>(R.id.localEngineStatus).setOnClickListener {
            if (!LocalEngine.isAvailable && !LocalEngine.isBooting) {
                val app = this@PairingActivity.application
                Thread({
                    LocalEngine.start(AndroidPlatform(app), app.filesDir)
                }, "soundsible-python-retry").start()
            }
            refreshEngineStatus()
        }

        findViewById<Button>(R.id.pairButton).setOnClickListener {
            val base = serverUrl.text.toString().trim()
            val code = pairingCode.text.toString().trim()
            if (base.isEmpty() || code.isEmpty()) {
                status.text = "Enter the server URL and the pairing code."
                return@setOnClickListener
            }
            status.text = "Pairing…"
            scope.launch {
                try {
                    val outcome = coordinator().pair(base, code, deviceName())
                    onOutcome(outcome, status)
                } catch (e: Exception) {
                    status.text = messageOf(e)
                }
            }
        }

        findViewById<Button>(R.id.pairTokenButton).setOnClickListener {
            val base = serverUrl.text.toString().trim()
            val token = deviceToken.text.toString().trim()
            if (base.isEmpty() || token.isEmpty()) {
                status.text = "Enter the server URL and the device token."
                return@setOnClickListener
            }
            status.text = "Verifying…"
            scope.launch {
                try {
                    val outcome = coordinator().pairManually(base, token)
                    onOutcome(outcome, status)
                } catch (e: Exception) {
                    status.text = messageOf(e)
                }
            }
        }

        findViewById<Button>(R.id.startLocalButton).setOnClickListener { button ->
            button.isEnabled = false
            status.text = "Starting the engine on this phone…"
            scope.launch {
                startLocalEngine(status)
                withContext(Dispatchers.Main) { button.isEnabled = true }
            }
        }
    }

    private suspend fun startLocalEngine(status: TextView) {
        if (!LocalEngine.isAvailable) {
            withContext(Dispatchers.Main) {
                status.text = "On-device Python is unavailable on this phone."
            }
            return
        }
        withContext(Dispatchers.IO) {
            // The engine serves the bundled web player from SOUNDSIBLE_UI_DIST;
            // install it before boot so first start already has management UI.
            val uiDir = java.io.File(filesDir, "soundsible/ui")
            val hasUi = LocalEngine.installWebUi(assets, uiDir)
            if (!hasUi) {
                withContext(Dispatchers.Main) {
                    status.text = "This build carries no web player bundle; " +
                        "the engine will still start for native browsing."
                }
            }
            val started = LocalEngine.startLocalServer(filesDir)
            if (!started) {
                withContext(Dispatchers.Main) {
                    status.text = "Could not start the local engine."
                }
                return@withContext
            }
            // The engine boots like a desktop sidecar: config, library,
            // watcher, then the loopback server. Poll for readiness.
            var lastPhase = ""
            repeat(100) {
                val connection = LocalEngine.localConnection()
                if (connection != null) {
                    (application as SoundsibleApp).tokenStore.save(connection)
                    withContext(Dispatchers.Main) {
                        startActivity(Intent(this@PairingActivity, LibraryActivity::class.java))
                        finish()
                    }
                    return@withContext
                }
                val (phase, _) = LocalEngine.localStatus()
                if (phase != lastPhase) {
                    lastPhase = phase
                    withContext(Dispatchers.Main) {
                        status.text = "Local engine: $phase…"
                    }
                }
                kotlinx.coroutines.delay(1_000)
            }
            val (phase, error) = LocalEngine.localStatus()
            withContext(Dispatchers.Main) {
                status.text = "The local engine did not become ready (phase: $phase)." +
                    (if (!error.isNullOrEmpty()) "\n${error.take(500)}" else "")
            }
        }
    }

    override fun onResume() {
        super.onResume()
        refreshEngineStatus()
    }

    private fun refreshEngineStatus() {
        val build = try {
            val info = packageManager.getPackageInfo(packageName, 0)
            "build ${info.longVersionCode}"
        } catch (_: Exception) {
            ""
        }
        findViewById<TextView>(R.id.localEngineStatus).text = when {
            LocalEngine.isAvailable ->
                "On-device Python ${LocalEngine.pythonVersion} ready $build (tap to retry)."
            LocalEngine.isBooting ->
                "Starting on-device Python… $build"
            else ->
                "On-device Python unavailable $build (${LocalEngine.deviceFacts(filesDir)})" +
                    (LocalEngine.startupError?.let { ": $it" } ?: "") +
                    "; pairing with a server still works. Tap to retry.\nBoot trace:\n${LocalEngine.traceTail()}"
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun coordinator(): PairingCoordinator {
        val app = application as SoundsibleApp
        return PairingCoordinator(app.client, app.tokenStore)
    }

    private fun deviceName(): String = (application as SoundsibleApp).deviceIdentity.deviceName

    private suspend fun onOutcome(outcome: PairingOutcome, status: TextView) {
        when (outcome) {
            is PairingOutcome.Paired -> withContext(Dispatchers.Main) {
                startActivity(Intent(this@PairingActivity, LibraryActivity::class.java))
                finish()
            }
            PairingOutcome.AwaitingOwnerConfirmation -> withContext(Dispatchers.Main) {
                status.text = "The code was accepted but the owner still has to confirm " +
                    "on the Soundsible. Keep the pairing sheet open (it turns on " +
                    "auto-confirm) and try again."
            }
        }
    }

    private fun messageOf(e: Exception): String = when (e) {
        is SoundsibleError -> e.message ?: "Pairing failed."
        else -> "Could not reach your Soundsible: ${e.message ?: e.javaClass.simpleName}"
    }
}
