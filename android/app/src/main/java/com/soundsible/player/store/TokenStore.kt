package com.soundsible.player.store

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.soundsible.player.data.ServerConnection
import com.soundsible.player.data.parseJsonObject

/** Where the paired-device token is kept. On Android this is EncryptedSharedPreferences. */
interface TokenStore {
    fun load(): ServerConnection?
    fun save(connection: ServerConnection)
    fun clear()
}

/** In-memory store for tests and previews. Mirrors `InMemoryTokenStore`. */
class InMemoryTokenStore(initial: ServerConnection? = null) : TokenStore {
    @Volatile private var connection: ServerConnection? = initial

    @Synchronized override fun load(): ServerConnection? = connection

    @Synchronized override fun save(connection: ServerConnection) {
        this.connection = connection
    }

    @Synchronized override fun clear() {
        connection = null
    }
}

private const val PREFS_FILE = "soundsible_prefs"
private const val KEY_CONNECTION = "server_connection"

/** Encrypted store used on device. Falls back to plain private prefs only if encryption is unavailable. */
class SharedPrefsTokenStore(context: Context) : TokenStore {
    private val appContext = context.applicationContext
    private val prefs: SharedPreferences by lazy { encryptedPrefs(appContext) }

    private fun encryptedPrefs(context: Context): SharedPreferences {
        return try {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            EncryptedSharedPreferences.create(
                context,
                PREFS_FILE,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        } catch (_: Exception) {
            context.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
        }
    }

    override fun load(): ServerConnection? {
        val raw = prefs.getString(KEY_CONNECTION, null) ?: return null
        return try {
            ServerConnection.parse(raw)
        } catch (_: Exception) {
            null
        }
    }

    override fun save(connection: ServerConnection) {
        prefs.edit().putString(KEY_CONNECTION, connection.toJsonString()).apply()
    }

    override fun clear() {
        prefs.edit().remove(KEY_CONNECTION).apply()
    }
}
