package com.soundsible.android
import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.intent.Intents
import androidx.test.espresso.intent.Intents.intending
import androidx.test.espresso.intent.matcher.IntentMatchers.hasComponent
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit
/**
 * Signing in by a pairing code another device is showing: typed or scanned, it opens that account
 * as an ordinary session, never while the code is hidden, and revoking it from Paired devices signs
 * the phone out. The camera result is stubbed here; the real scanner is opened and closed separately.
 */
class PairingTest {
    @Test fun httpPairing() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")!!)
    @Test fun tlsPairing() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin")!!)
    @Test fun scannerOpensAndClosesWithoutACode() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName, android.Manifest.permission.CAMERA)
        ActivityScenario.launchActivityForResult(PairingScanActivity::class.java).use { scenario ->
            Thread.sleep(2000) // Let CameraX bind the emulator camera; a failure to bind would finish the activity itself.
            scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
            assertEquals(Activity.RESULT_CANCELED, scenario.result.resultCode)
            assertEquals("cancelled", scenario.result.resultData.getStringExtra(PairingScanActivity.EXTRA_ERROR))
            assertNull(scenario.result.resultData.getStringExtra(PairingScanActivity.EXTRA_TEXT))
        }
    }
    private fun run(origin: String) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val connection = EngineConnection.shared(context)
        connection.clearSession(true); connection.configure(origin) // transport only; the app starts unconfigured below
        // The owner's own browser, independent of the app's session.
        var ownerCookie = ""
        fun owner(path: String, method: String = "GET", body: JSONObject? = null): JSONObject {
            val request = Request.Builder().url(origin + path).apply {
                if (ownerCookie.isNotEmpty()) header("Cookie", ownerCookie)
                if (method != "GET") method(method, (body ?: JSONObject()).toString().toRequestBody("application/json".toMediaType()))
            }.build()
            connection.client.newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty(); check(response.isSuccessful) { "$path ${response.code}: $text" }
                response.headers("Set-Cookie").firstOrNull { it.startsWith("sb_session=") }?.let { ownerCookie = it.substringBefore(';') }
                return JSONObject(text)
            }
        }
        fun core(path: String): JSONObject = connection.execute(path, "GET", null, emptyMap(), connection.generation, "pairing-check", 15000).use {
            val text = it.body?.string().orEmpty(); check(it.isSuccessful) { "$path ${it.code}: $text" }; JSONObject(text)
        }
        fun show(display: Boolean = true) = owner("/api/pairing/sessions", "POST", JSONObject().put("auto_confirm", true).put("display_active", display)).getString("code")
        fun qr(code: String) = JSONObject().put("type", "soundsible_pairing").put("version", 1).put("code", code)
            .put("claim_url", "$origin/api/pairing/sessions/claim").put("player_url", "$origin/player/").toString()
        owner("/api/auth/login", "POST", JSONObject().put("username", "owner").put("password", "android-test"))
        val hidden = show(display = false)
        val typed = show()
        val name = DeviceName.get(context)
        connection.clearSession(true)
        val web = StartupTest()
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                fun waitFor(condition: String, seconds: Long = 45) {
                    val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds)
                    while (System.nanoTime() < until) { if (web.evaluate(scenario, condition) == "true") return; Thread.sleep(100) }
                    fail("Pairing condition: $condition; " + web.evaluate(scenario, "document.body.innerText"))
                }
                fun js(script: String) = web.evaluate(scenario, script)
                fun type(selector: String, value: String) = js("(()=>{const field=document.querySelector(${JSONObject.quote(selector)});field.value=${JSONObject.quote(value)};field.dispatchEvent(new Event('input',{bubbles:true}))})()")
                fun button(label: String) = "Array.from(document.querySelectorAll('button')).find(b=>b.getClientRects().length>0&&b.textContent.trim()===${JSONObject.quote(label)})"
                web.awaitReady(scenario); js("localStorage.setItem('lang','en')"); scenario.recreate(); web.awaitReady(scenario)

                // A hidden code never signs in and is not consumed.
                type("input[type=url]", origin)
                js("document.querySelector('[data-pairing-manual]').click()"); waitFor("!!document.querySelector('[data-pairing-code]')")
                type("[data-pairing-code]", hidden.lowercase())
                js("document.querySelector('[data-pairing-form]').requestSubmit()")
                waitFor("document.body.innerText.includes('Keep the pairing code open')")
                assertNull(connection.sessionIdentity(connection.generation))
                val sessions = owner("/api/pairing/sessions").getJSONArray("sessions")
                assertEquals("pending", (0 until sessions.length()).map(sessions::getJSONObject).first { it.getString("code") == hidden }.getString("status"))

                // A showing code, typed loosely, opens the owner's account as an ordinary session named after this phone.
                type("[data-pairing-code]", typed.substring(0, 4).lowercase() + "-" + typed.substring(4))
                js("document.querySelector('[data-pairing-form]').requestSubmit()")
                waitFor("!!document.querySelector('[data-testid=android-library]')&&!document.querySelector('[data-pairing]')")
                assertEquals("owner", core("/api/auth/state").getJSONObject("user").getString("username"))
                val paired = owner("/api/paired-devices").getJSONArray("devices")
                assertEquals(1, paired.length()); assertEquals(name, paired.getJSONObject(0).getString("name")); assertEquals("session", paired.getJSONObject(0).getString("kind"))

                // Revoking it from Paired devices on the phone itself signs the phone out.
                js("document.querySelector('[data-android-settings]').click()"); waitFor("!!document.querySelector('[data-android-settings-devices]')")
                js("document.querySelector('[data-android-settings-devices]').click()")
                waitFor("document.querySelector('[data-setting=paired-devices]')?.textContent.includes(${JSONObject.quote(name)})===true")
                js("Array.from(document.querySelectorAll('[data-setting=paired-devices] button')).find(b=>b.textContent.trim()==='Revoke').click()")
                waitFor("!!document.querySelector('[role=dialog]')")
                js("Array.from(document.querySelectorAll('[role=dialog] button')).find(b=>b.textContent.trim()==='Revoke').click()")
                waitFor("!!document.querySelector('[data-pairing-scan]')&&!document.querySelector('[data-testid=android-library]')")
                assertEquals(0, owner("/api/paired-devices").getJSONArray("devices").length())

                Intents.init()
                try {
                    // Camera refused: say so and offer the typed code instead.
                    intending(hasComponent(PairingScanActivity::class.java.name)).respondWith(Instrumentation.ActivityResult(Activity.RESULT_CANCELED,
                        Intent().putExtra(PairingScanActivity.EXTRA_ERROR, "camera_denied")))
                    js("document.querySelector('[data-pairing-scan]').click()")
                    waitFor("document.body.innerText.includes('The camera is needed to scan')&&!!document.querySelector('[data-pairing-form]')")
                    assertNull(connection.sessionIdentity(connection.generation))
                    // A scanned code signs in exactly like a typed one.
                    Intents.release(); Intents.init()
                    intending(hasComponent(PairingScanActivity::class.java.name)).respondWith(Instrumentation.ActivityResult(Activity.RESULT_OK,
                        Intent().putExtra(PairingScanActivity.EXTRA_TEXT, qr(show()))))
                    js("${button("Scan pairing code")}.click()")
                    waitFor("!!document.querySelector('[data-testid=android-library]')")
                    assertEquals("owner", core("/api/auth/state").getJSONObject("user").getString("username"))
                    assertEquals(1, owner("/api/paired-devices").getJSONArray("devices").length())
                } finally { Intents.release() }
            }
        } finally { connection.clearSession(true) }
    }
}
