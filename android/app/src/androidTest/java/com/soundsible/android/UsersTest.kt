package com.soundsible.android

import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

/** Shared People panel uses native account and transport; member never gains administration. */
class UsersTest {
    @Test fun httpPeople() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")!!)
    @Test fun tlsPeople() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin")!!)
    private fun run(origin: String) {
        val connection = EngineConnection.shared(InstrumentationRegistry.getInstrumentation().targetContext)
        connection.clearSession(true); connection.configure(origin)
        fun core(path: String, method: String = "GET", body: JSONObject? = null): JSONObject = connection.execute(path, method,
            body?.toString()?.toRequestBody("application/json".toMediaType()), emptyMap(), connection.generation, "native-people", 15000).use {
                val text = it.body?.string().orEmpty(); check(it.isSuccessful) { "$path ${it.code}: $text" }; if (text.isBlank()) JSONObject() else JSONObject(text)
            }
        core("/api/auth/login", "POST", JSONObject().put("username", "owner").put("password", "android-test"))
        val username = "managed_" + java.util.UUID.randomUUID().toString().take(8)
        val web = StartupTest()
        var addedId: String? = null
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                fun waitFor(condition: String) {
                    val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
                    while (System.nanoTime() < until) { if (web.evaluate(scenario, condition) == "true") return; Thread.sleep(100) }
                    fail("People condition: $condition; " + web.evaluate(scenario, "document.body.innerText"))
                }
                waitFor("!!document.querySelector('[data-testid=android-library]')&&!document.documentElement.hasAttribute('data-booting')")
                web.evaluate(scenario, "localStorage.setItem('lang','en')"); scenario.recreate()
                waitFor("!!document.querySelector('[data-testid=android-library]')&&!document.documentElement.hasAttribute('data-booting')")
                web.evaluate(scenario, "Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent==='Settings').click()")
                waitFor("!!document.querySelector('[data-android-settings-users]')")
                web.evaluate(scenario, "document.querySelector('[data-android-settings-users]').click()")
                waitFor("document.querySelector('[data-testid=android-settings-users]').innerText.includes('@member')")
                web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-testid=android-settings-users] button')).find(b=>b.textContent==='Create invite link').click()")
                waitFor("!!document.querySelector('[data-testid=android-settings-users] input[readonly]')")
                val link = org.json.JSONTokener(web.evaluate(scenario, "document.querySelector('[data-testid=android-settings-users] input[readonly]').value")).nextValue() as String
                assertTrue(link.contains("/player/#/invite/")); assertFalse(link.contains("android-test"))
                val invites = core("/api/invites").getJSONArray("invites"); assertTrue(invites.length() > 0)
                web.evaluate(scenario, "(()=>{const user=document.getElementById('new-username');user.value=${JSONObject.quote(username)};user.dispatchEvent(new Event('input',{bubbles:true}));const name=document.getElementById('new-display-name');name.value='Managed Android';name.dispatchEvent(new Event('input',{bubbles:true}));for(const field of user.form.querySelectorAll('input[autocomplete=new-password]')){field.value='android-test';field.dispatchEvent(new Event('input',{bubbles:true}));}user.form.requestSubmit()})()")
                waitFor("document.querySelector('[data-testid=android-settings-users]').innerText.includes('@$username')")
                val users = core("/api/users").getJSONArray("users")
                val added = (0 until users.length()).map { users.getJSONObject(it) }.single { it.getString("username") == username }
                addedId = added.getString("id"); assertEquals("member", added.getString("role"))
                web.evaluate(scenario, "(()=>{const row=Array.from(document.querySelectorAll('[data-testid=android-settings-users] li')).find(e=>e.textContent.includes('@$username'));Array.from(row.querySelectorAll('button')).find(b=>b.textContent==='Disable').click()})()")
                waitFor("Array.from(document.querySelectorAll('[data-testid=android-settings-users] li')).find(e=>e.textContent.includes('@$username')).innerText.includes('Enable')")
                val disabled = core("/api/users").getJSONArray("users")
                assertTrue((0 until disabled.length()).map { disabled.getJSONObject(it) }.single { it.getString("id") == addedId }.getBoolean("disabled"))
                connection.clearSession(false); connection.configure(origin)
                core("/api/auth/login", "POST", JSONObject().put("username", "member").put("password", "android-test"))
                scenario.recreate()
                waitFor("!!document.querySelector('[data-testid=android-library]')&&!document.documentElement.hasAttribute('data-booting')")
                web.evaluate(scenario, "Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent==='Settings').click()")
                waitFor("!!document.querySelector('[data-testid=android-settings-account]')")
                assertEquals("false", web.evaluate(scenario, "!!document.querySelector('[data-android-settings-users]')"))
                connection.execute("/api/users", "GET", null, emptyMap(), connection.generation, "member-denied", 15000).use { assertEquals(403, it.code) }
            }
        } finally {
            runCatching {
                core("/api/auth/login", "POST", JSONObject().put("username", "owner").put("password", "android-test"))
                addedId?.let { core("/api/users/$it", "DELETE") }
            }
            connection.clearSession(true)
        }
    }
}
