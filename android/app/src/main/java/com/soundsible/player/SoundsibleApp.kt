package com.soundsible.player

import android.app.Application
import com.chaquo.python.android.AndroidPlatform
import com.soundsible.player.net.SoundsibleClient
import com.soundsible.player.net.UrlConnectionTransport
import com.soundsible.player.store.DeviceIdentity
import com.soundsible.player.store.SharedPrefsTokenStore
import com.soundsible.player.store.TokenStore

/** Service locator for the app. No DI framework on purpose. */
class SoundsibleApp : Application() {
    lateinit var tokenStore: TokenStore
        private set
    lateinit var client: SoundsibleClient
        private set
    lateinit var deviceIdentity: DeviceIdentity
        private set

    override fun onCreate() {
        super.onCreate()
        tokenStore = SharedPrefsTokenStore(this)
        client = SoundsibleClient(UrlConnectionTransport(), tokenStore)
        deviceIdentity = DeviceIdentity(this)
        // Best-effort: boot the embedded interpreter for the future local
        // engine. Remote pairing never depends on it. Off the main thread:
        // first-run asset extraction can take tens of seconds.
        val platform = com.chaquo.python.android.AndroidPlatform(this)
        Thread({ LocalEngine.start(platform) }, "soundsible-python-boot").start()
    }
}
