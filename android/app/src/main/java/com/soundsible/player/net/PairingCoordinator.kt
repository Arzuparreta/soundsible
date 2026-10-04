package com.soundsible.player.net

import com.soundsible.player.data.ServerConnection
import com.soundsible.player.store.TokenStore

sealed interface PairingOutcome {
    /** Done -- the engine minted a token and it is stored. */
    data class Paired(val connection: ServerConnection) : PairingOutcome

    /**
     * The code was accepted but the owner still has to confirm on the
     * Soundsible. Opening the pairing sheet on the server (which turns on
     * auto-confirm) is the way through.
     */
    data object AwaitingOwnerConfirmation : PairingOutcome
}

/** Drives the pairing screen. Mirrors `PairingCoordinator` in ios/SoundsibleKit. */
class PairingCoordinator(
    private val client: SoundsibleClient,
    private val tokenStore: TokenStore,
) {
    /** Claim a code against a server and store the credential if one comes back. */
    suspend fun pair(baseUrl: String, code: String, deviceName: String): PairingOutcome {
        val claim = client.claimPairingCode(baseUrl, code, deviceName)
        val token = claim.token
        if (token.isNullOrEmpty()) return PairingOutcome.AwaitingOwnerConfirmation
        val connection = ServerConnection(baseUrl.trimEnd('/'), token)
        tokenStore.save(connection)
        return PairingOutcome.Paired(connection)
    }

    /**
     * Accept a base URL and a token typed or pasted by hand. Verified before
     * being stored so a typo fails on the pairing screen instead of on the
     * library screen; a rejection restores the previous credential.
     */
    suspend fun pairManually(baseUrl: String, token: String): PairingOutcome {
        val connection = ServerConnection(baseUrl.trimEnd('/'), token)
        val previous = tokenStore.load()
        tokenStore.save(connection)
        try {
            if (!client.verifyPairing()) throw SoundsibleError.Unauthorized
            return PairingOutcome.Paired(connection)
        } catch (e: Exception) {
            if (previous != null) tokenStore.save(previous) else tokenStore.clear()
            throw e
        }
    }
}
