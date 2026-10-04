package com.soundsible.player.ui

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
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
        findViewById<TextView>(R.id.localEngineStatus).text = if (LocalEngine.isAvailable) {
            "On-device Python ${LocalEngine.pythonVersion} ready (local engine in progress)."
        } else {
            "On-device Python unavailable; pairing with a server still works."
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
                        startActivity(Intent(this@PairingActivity, BrowseActivity::class.java))
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
                startActivity(Intent(this@PairingActivity, BrowseActivity::class.java))
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
