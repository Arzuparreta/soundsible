package com.soundsible.android

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

/** A fresh install prompts only on prepare; either system choice completes the copy. */
class NotificationPermissionTest {
    @Test fun offlineCopyRespectsNotificationChoice() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val origin = InstrumentationRegistry.getArguments().getString("fixtureOrigin")!!
        val allow = InstrumentationRegistry.getArguments().getString("notificationChoice") == "allow"
        val connection = EngineConnection.shared(context)
        connection.clearSession(true)
        val prefs = context.getSharedPreferences("soundsible-notifications", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        val initiallyGranted = context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        val web = StartupTest()
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                fun waitFor(condition: String) {
                    val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(40)
                    while (System.nanoTime() < until) { if (web.evaluate(scenario, condition) == "true") return; Thread.sleep(100) }
                    fail("Notification choice: $condition; " + web.evaluate(scenario, "document.body.innerText + window.__notificationError"))
                }
                web.awaitReady(scenario)
                assertFalse("Startup requested notifications", prefs.getBoolean("asked", false))
                web.evaluate(scenario, "document.querySelector('input[type=url]').value=${JSONObject.quote(origin)};document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()")
                waitFor("!!document.querySelector('input[type=password]')")
                web.evaluate(scenario, "document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()")
                waitFor("!!document.querySelector('[data-testid=android-library]')&&!document.documentElement.hasAttribute('data-booting')")
                assertFalse("Sign-in requested notifications", prefs.getBoolean("asked", false))
                fun prepare() {
                    web.evaluate(scenario, "window.__notificationDone=false;window.__notificationError='';Capacitor.Plugins.SoundsibleOffline.command({action:'prepare',generation:${connection.generation},tracks:[{id:'member-track',title:'member private song',artist:'member artist'}],playlists:{}}).then(()=>window.__notificationDone=true).catch(e=>window.__notificationError=e.message)")
                }
                prepare()
                if (android.os.Build.VERSION.SDK_INT >= 33 && !initiallyGranted) {
                    val buttonId = "com.android.permissioncontroller:id/permission_" + if (allow) "allow_button" else "deny_button"
                    val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
                    var answered = false
                    while (System.nanoTime() < until && !answered) {
                        val buttons = instrumentation.uiAutomation.rootInActiveWindow?.findAccessibilityNodeInfosByViewId(buttonId)
                        if (!buttons.isNullOrEmpty()) answered = buttons.first().performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK)
                        if (!answered) Thread.sleep(100)
                    }
                    assertTrue("System notification dialog did not appear", answered)
                    assertTrue(prefs.getBoolean("asked", false))
                    assertEquals(allow, context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
                }
                waitFor("window.__notificationDone===true")
                val store = OfflineStore.shared(context)
                val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(40)
                while (store.local("member-track", connection.generation) == null && System.nanoTime() < until) Thread.sleep(100)
                assertNotNull("Copy did not complete after the permission choice", store.local("member-track", connection.generation))
                store.remove(connection.generation, org.json.JSONArray().put("member-track"))
                prepare() // Denial must not cause another prompt or prevent another preparation.
                waitFor("window.__notificationDone===true")
            }
        } finally {
            connection.clearSession(true)
            if (android.os.Build.VERSION.SDK_INT >= 33) instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}
