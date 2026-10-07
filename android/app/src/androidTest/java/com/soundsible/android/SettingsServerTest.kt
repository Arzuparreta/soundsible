package com.soundsible.android
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit
/**
 * Library, Downloads, Community, About and this-device Settings against the real engine.
 * Destructive maintenance runs only where it cannot touch shared fixture audio: rescan and
 * purge on a throwaway account, and the empty-library flow only up to its count guard.
 */
class SettingsServerTest {
    @Test fun httpServerSettings() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")!!)
    @Test fun tlsServerSettings() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin")!!)
    private fun run(origin: String) {
        val connection = EngineConnection.shared(InstrumentationRegistry.getInstrumentation().targetContext)
        fun core(path: String, method: String = "GET", body: JSONObject? = null): JSONObject = connection.execute(path, method,
            body?.toString()?.toRequestBody("application/json".toMediaType()), emptyMap(), connection.generation, "settings-server", 15000).use {
                val text = it.body?.string().orEmpty(); check(it.isSuccessful) { "$path ${it.code}: $text" }; JSONObject(text)
            }
        connection.clearSession(true); connection.configure(origin)
        core("/api/auth/login", "POST", JSONObject().put("username", "owner").put("password", "android-test"))
        val username = "settings_" + java.util.UUID.randomUUID().toString().take(8)
        core("/api/users", "POST", JSONObject().put("username", username).put("password", "android-test").put("role", "admin"))
        connection.clearSession(true)
        val web = StartupTest()
        var quality: String? = null
        var deviceName: String? = null
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                fun waitFor(condition: String, seconds: Long = 45) {
                    val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds)
                    while (System.nanoTime() < until) { if (web.evaluate(scenario, condition) == "true") return; Thread.sleep(100) }
                    fail("Settings condition: $condition; " + web.evaluate(scenario, "document.body.innerText"))
                }
                fun js(script: String) = web.evaluate(scenario, script)
                fun button(label: String, scope: String = "document") = "Array.from($scope.querySelectorAll('button')).find(b=>b.getClientRects().length>0&&b.textContent.trim()===${JSONObject.quote(label)})"
                fun click(label: String, scope: String = "document") { waitFor("!!${button(label, scope)}&&!${button(label, scope)}.disabled"); js("${button(label, scope)}.click()") }
                fun row(anchor: String) = "document.querySelector('[data-setting=$anchor]')"
                fun tab(name: String) { js("document.querySelector('[data-android-settings-$name]').click()") }
                val dialog = "document.querySelector('[role=dialog]')"
                web.awaitReady(scenario); js("localStorage.setItem('lang','en')"); scenario.recreate(); web.awaitReady(scenario)
                js("document.querySelector('input[type=url]').value=${JSONObject.quote(origin)};document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()")
                waitFor("!!document.querySelector('input[type=password]')")
                js("document.querySelector('input[autocomplete=username]').value=${JSONObject.quote(username)};document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()")
                waitFor("!!document.querySelector('[data-testid=android-library]')&&!!document.querySelector('[data-android-settings]')")
                js("document.querySelector('[data-android-settings]').click()"); waitFor("!!document.querySelector('[data-android-settings-library]')")

                // Library: a fresh account starts empty; a real rescan fills it and the row shows what Core now holds.
                tab("library")
                waitFor("${row("track-count")}?.textContent.includes('0')===true&&!!${row("cloud-sync")}&&!!${row("empty-library")}")
                js("${row("rescan")}.click()")
                waitFor("document.body.innerText.includes('Scan complete')", 90)
                val scanned = core("/api/library").getJSONArray("tracks").length()
                assertTrue("Rescan added nothing to the throwaway account", scanned > 0)
                waitFor("${row("track-count")}?.textContent.trim().endsWith(${JSONObject.quote(scanned.toString())})===true")
                js("${row("purge-missing")}.click()"); waitFor("!!$dialog"); click("Cancel", dialog); waitFor("!$dialog")
                js("${row("purge-missing")}.click()"); waitFor("!!$dialog"); click("Purge", dialog)
                waitFor("document.body.innerText.includes('Purged (0)')")
                assertEquals(scanned, core("/api/library").getJSONArray("tracks").length())
                js("${row("empty-library")}.click()"); waitFor("!!$dialog"); click("Empty everything", dialog)
                waitFor("!!document.querySelector('[role=dialog] input')")
                js("(()=>{const input=document.querySelector('[role=dialog] input');input.value=${JSONObject.quote((scanned + 1).toString())};input.dispatchEvent(new Event('input',{bubbles:true}))})()")
                assertEquals("true", js("${button("Empty everything", dialog)}.disabled"))
                click("Cancel", dialog); waitFor("!$dialog")
                Thread.sleep(500)
                assertEquals(scanned, core("/api/library").getJSONArray("tracks").length())

                // Downloads (admin): the control shows the stored value and changes it only through Core.
                quality = core("/api/downloader/config").getString("quality")
                val next = if (quality == "low") "normal" else "low"
                val label = if (next == "low") "Low" else "Normal"
                tab("downloads")
                waitFor("!!${row("quality")}&&${button(if (quality == "low") "Low" else if (quality == "normal") "Normal" else "High", row("quality"))}?.getAttribute('aria-pressed')==='true'")
                click(label, row("quality"))
                waitFor("${button(label, row("quality"))}.getAttribute('aria-pressed')==='true'&&document.querySelector('[data-testid=android-settings-downloads]').getAttribute('aria-busy')==='false'")
                assertEquals(next, core("/api/downloader/config").getString("quality"))

                // Community and About report what the server answers.
                tab("community")
                val community = core("/api/community/config").getString("state")
                val expected = mapOf("available" to "Available", "disabled" to "Disabled by configuration", "invalid" to "Invalid configuration", "unavailable" to "Unreachable")[community]!!
                waitFor("${row("community-status")}?.textContent.includes(${JSONObject.quote(expected)})===true")
                tab("about")
                val engine = core("/api/health").getString("version")
                waitFor("/\\(\\d+\\)/.test(${row("version")}?.textContent??'')&&document.querySelector('[data-testid=android-settings-about]').textContent.includes(${JSONObject.quote(engine)})")

                // This device: renamed through the service; Core's device list shows the new name.
                tab("devices")
                waitFor("(${row("device-name")}?.textContent.trim().length??0)>'Name'.length&&!${row("device-name")}.disabled")
                deviceName = js("${row("device-name")}.textContent.replace(/^Name/,'').trim()").trim('"')
                val renamed = "Settings test " + username.takeLast(4)
                js("${row("device-name")}.click()"); waitFor("!!document.querySelector('[role=dialog] input')")
                js("(()=>{const input=document.querySelector('[role=dialog] input');input.value=${JSONObject.quote(renamed)};input.dispatchEvent(new Event('input',{bubbles:true}))})()")
                click("Save", dialog)
                waitFor("${row("device-name")}?.textContent.includes(${JSONObject.quote(renamed)})===true")
                val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
                fun named(): Boolean { val rows = core("/api/devices").getJSONArray("devices"); return (0 until rows.length()).any { rows.getJSONObject(it).optString("device_name") == renamed } }
                while (!named() && System.nanoTime() < until) Thread.sleep(250)
                assertTrue("Core never saw the new device name", named())
                waitFor("!!${button("Pair a new device")}")
                // Leave this install's name as it was found.
                js("${row("device-name")}.click()"); waitFor("!!document.querySelector('[role=dialog] input')")
                js("(()=>{const input=document.querySelector('[role=dialog] input');input.value=${JSONObject.quote(deviceName!!)};input.dispatchEvent(new Event('input',{bubbles:true}))})()")
                click("Save", dialog)
                waitFor("${row("device-name")}?.textContent.includes(${JSONObject.quote(deviceName!!)})===true")
            }
        } finally {
            runCatching { quality?.let { core("/api/downloader/config", "POST", JSONObject().put("quality", it)) } }
            connection.clearSession(true)
        }
    }
}
