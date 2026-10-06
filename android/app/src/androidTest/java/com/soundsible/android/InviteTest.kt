package com.soundsible.android

import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

/** Owner creates a real single-use invitation; native UI registers and persists a separate member. */
class InviteTest {
    @Test fun httpInvite() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")!!)
    @Test fun tlsInvite() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin")!!)
    private fun run(origin: String) {
        val connection = EngineConnection.shared(InstrumentationRegistry.getInstrumentation().targetContext)
        connection.clearSession(true); connection.configure(origin)
        fun core(path: String, method: String = "GET", body: JSONObject? = null): JSONObject = connection.execute(path, method,
            body?.toString()?.toRequestBody("application/json".toMediaType()), emptyMap(), connection.generation, "invite-acceptance", 15000).use {
                val text = it.body?.string().orEmpty(); check(it.isSuccessful) { "$path ${it.code}: $text" }; JSONObject(text)
            }
        core("/api/auth/login", "POST", JSONObject().put("username", "owner").put("password", "android-test"))
        val invitation = core("/api/invites", "POST", JSONObject())
        val token = invitation.getString("token")
        val username = "invited_" + java.util.UUID.randomUUID().toString().take(8)
        connection.clearSession(true)
        val web = StartupTest()
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                fun waitFor(condition: String) {
                    val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
                    while (System.nanoTime() < until) { if (web.evaluate(scenario, condition) == "true") return; Thread.sleep(100) }
                    fail("Invite condition: $condition; " + web.evaluate(scenario, "document.body.innerText"))
                }
                web.awaitReady(scenario); web.evaluate(scenario, "localStorage.setItem('lang','en')"); scenario.recreate(); web.awaitReady(scenario)
                web.evaluate(scenario, "(()=>{const field=document.querySelector('input[type=url]');field.value=${JSONObject.quote("$origin/player/#/invite/$token")};field.dispatchEvent(new Event('input',{bubbles:true}));field.form.requestSubmit()})()")
                waitFor("!!document.querySelector('[data-native-invite] input[autocomplete=username]')")
                assertEquals(origin, connection.origin)
                assertFalse("Invite token persisted as server setting", connection.origin.contains(token))
                web.evaluate(scenario, "(()=>{const root=document.querySelector('[data-native-invite]');const user=root.querySelector('input[autocomplete=username]');user.value=${JSONObject.quote(username)};user.dispatchEvent(new Event('input',{bubbles:true}));for(const field of root.querySelectorAll('input[autocomplete=new-password]')){field.value='android-test';field.dispatchEvent(new Event('input',{bubbles:true}));}})()")
                waitFor("!!Array.from(document.querySelectorAll('[data-native-invite] button')).find(b=>b.textContent==='Create my account'&&!b.disabled)")
                web.evaluate(scenario, "document.querySelector('[data-native-invite] form').requestSubmit()")
                waitFor("!!document.querySelector('[data-testid=android-library]')&&!document.querySelector('[data-native-invite]')")
                val user = core("/api/auth/state").getJSONObject("user")
                assertEquals(username, user.getString("username")); assertEquals("member", user.getString("role"))
                assertNotNull(connection.cookieHeader(connection.generation))
                assertEquals(user.getString("id"), connection.offline.state(connection.generation).getJSONObject("user").getString("id"))
                assertEquals("New account leaked another user's music", 0, core("/api/library").getJSONArray("tracks").length())
                scenario.recreate()
                waitFor("!!document.querySelector('[data-testid=android-library]')&&!document.documentElement.hasAttribute('data-booting')")
                assertEquals(user.getString("id"), core("/api/auth/state").getJSONObject("user").getString("id"))
                connection.execute("/api/invites/$token/accept", "POST", JSONObject().put("username", "reused_invite").put("password", "android-test").toString().toRequestBody("application/json".toMediaType()),
                    emptyMap(), connection.generation, "invite-single-use", 15000).use { assertEquals(400, it.code) }
                assertEquals(user.getString("id"), core("/api/auth/state").getJSONObject("user").getString("id"))
            }
        } finally { connection.clearSession(true) }
    }
}
