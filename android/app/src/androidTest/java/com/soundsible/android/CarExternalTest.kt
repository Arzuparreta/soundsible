package com.soundsible.android

import android.content.*
import android.os.*
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.*
import org.junit.Assume.assumeNotNull
import org.junit.Test
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** Independent test APK UID exercises the OS trust boundary and actual URI grants. */
class CarExternalTest {
    @Test fun httpExternalTrustAndArtwork() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"))
    @Test fun tlsExternalTrustAndArtwork() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"))
    private fun run(origin: String?) {
        assumeNotNull(origin)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val testPackage = instrumentation.context.packageName
        val listener = "$testPackage/com.soundsible.android.CarProbeNotificationListener"
        val connection = EngineConnection.shared(context)
        var bound = false
        var scenario: ActivityScenario<MainActivity>? = null
        val remote = CompletableFuture<Messenger>()
        val binding = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName, service: IBinder) { remote.complete(Messenger(service)) }
            override fun onServiceDisconnected(name: ComponentName) {}
        }
        fun shell(command: String) { instrumentation.uiAutomation.executeShellCommand(command).use { descriptor ->
            ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.readBytes() }
        } }
        fun probe(): Bundle {
            val result = CompletableFuture<Bundle>()
            val receiver = Messenger(object : Handler(Looper.getMainLooper()) {
                override fun handleMessage(message: Message) { result.complete(message.data) }
            })
            remote.get(15, TimeUnit.SECONDS).send(Message.obtain().apply {
                replyTo = receiver; data = Bundle().apply { putString("target", context.packageName) }
            })
            return result.get(20, TimeUnit.SECONDS)
        }
        try {
            shell("cmd notification disallow_listener $listener")
            connection.clearSession(true)
            val epoch = connection.configure(origin!!)
            connection.execute("/api/auth/login", "POST", "{\"username\":\"member\",\"password\":\"android-test\"}".toRequestBody("application/json".toMediaType()),
                emptyMap(), epoch, "car-external-login", 15000).use { assertTrue(it.isSuccessful) }
            scenario = ActivityScenario.launch(MainActivity::class.java)
            bound = context.bindService(Intent().setComponent(ComponentName(testPackage, CarExternalProbeService::class.java.name)), binding, Context.BIND_AUTO_CREATE)
            assertTrue(bound)
            val rejected = probe()
            assertNotEquals("Probe must execute under another UID", Process.myUid(), rejected.getInt("uid"))
            assertFalse("Untrusted external browser connected", rejected.getBoolean("connected"))
            shell("cmd notification allow_listener $listener")
            val trustedUntil = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
            val manager = context.getSystemService(android.media.session.MediaSessionManager::class.java)
            while (!manager.isTrustedForMediaControl(android.media.session.MediaSessionManager.RemoteUserInfo(testPackage, -1, rejected.getInt("uid"))) && System.nanoTime() < trustedUntil) Thread.sleep(100)
            assertTrue("OS did not authorize test notification listener", manager.isTrustedForMediaControl(android.media.session.MediaSessionManager.RemoteUserInfo(testPackage, -1, rejected.getInt("uid"))))
            val accepted = probe()
            assertTrue("Trusted external browser rejected: $accepted", accepted.getBoolean("connected"))
            assertNull("External artwork read failed", accepted.getString("error"))
            assertTrue("External URI grant did not allow actual image read", accepted.getBoolean("artwork"))
            assertTrue("External artwork must remain read-only", accepted.getBoolean("writeDenied"))
            assertTrue(accepted.getString("uri")!!.startsWith("content://${context.packageName}.carart/"))
        } finally {
            shell("cmd notification disallow_listener $listener")
            if (bound) context.unbindService(binding)
            scenario?.close()
            connection.clearSession(true)
        }
    }
}
