package com.soundsible.player.ui

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
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
