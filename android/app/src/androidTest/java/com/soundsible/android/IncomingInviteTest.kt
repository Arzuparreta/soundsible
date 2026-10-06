package com.soundsible.android
import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit
/** An invitation shared to the app by the OS changes no server or account until the user explicitly uses it. */
class IncomingInviteTest {
    @Test fun httpIncomingInvite() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")!!)
    @Test fun tlsIncomingInvite() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin")!!)
    private fun run(origin: String) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val connection = EngineConnection.shared(context)
        fun clearPending() { IncomingTrackState.pending(context)?.getString("token")?.let { IncomingTrackState.dismiss(context, it) } }
        fun core(path: String, method: String = "GET", body: JSONObject? = null): JSONObject = connection.execute(path, method,
            body?.toString()?.toRequestBody("application/json".toMediaType()), emptyMap(), connection.generation, "incoming-invite", 15000).use {
                val text = it.body?.string().orEmpty(); check(it.isSuccessful) { "$path ${it.code}: $text" }; JSONObject(text)
            }
        fun login(username: String) { connection.configure(origin); core("/api/auth/login", "POST", JSONObject().put("username", username).put("password", "android-test")) }
        fun send(token: String) = Intent(Intent.ACTION_SEND).setType("text/plain").setClass(context, MainActivity::class.java)
            .putExtra(Intent.EXTRA_TEXT, "Join my Soundsible\n$origin/player/#/invite/$token").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        connection.clearSession(true); clearPending()
        login("owner")
        val first = core("/api/invites", "POST", JSONObject()).getString("token")
        val second = core("/api/invites", "POST", JSONObject()).getString("token")
        connection.clearSession(true)
        val web = StartupTest()
        try {
            // Signed out and unconfigured: arrival shows the server, but only Connect configures it.
            ActivityScenario.launch<MainActivity>(send(first)).use { scenario ->
                fun waitFor(condition: String) {
                    val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
                    while (System.nanoTime() < until) { if (web.evaluate(scenario, condition) == "true") return; Thread.sleep(100) }
                    fail("Incoming invite condition: $condition; " + web.evaluate(scenario, "document.body.innerText"))
                }
                web.awaitReady(scenario); web.evaluate(scenario, "localStorage.setItem('lang','en')"); scenario.recreate(); web.awaitReady(scenario)
                waitFor("document.querySelector('[data-testid=android-incoming-invite]')?.textContent.includes(${JSONObject.quote(origin)})===true")
                assertEquals("", connection.origin)
                assertEquals("true", web.evaluate(scenario, "document.querySelector('[data-invite-connect]').textContent==='Connect'"))
                web.evaluate(scenario, "document.querySelector('[data-invite-connect]').click()")
                waitFor("!!document.querySelector('[data-native-invite] input[autocomplete=username]')&&!document.querySelector('[data-testid=android-incoming-invite]')")
                assertEquals(origin, connection.origin)
                assertNull(IncomingTrackState.pending(context))
                assertNull(connection.sessionIdentity(connection.generation))
            }
            // Signed in: arrival and Close keep the account; using it signs out first and opens the same invite form.
            connection.clearSession(true); login("member")
            val member = core("/api/auth/state").getJSONObject("user").getString("id")
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                fun waitFor(condition: String) {
                    val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
                    while (System.nanoTime() < until) { if (web.evaluate(scenario, condition) == "true") return; Thread.sleep(100) }
                    fail("Incoming invite condition: $condition; " + web.evaluate(scenario, "document.body.innerText"))
                }
                waitFor("!!document.querySelector('[data-testid=android-library]')&&!document.documentElement.hasAttribute('data-booting')")
                context.startActivity(send(second))
                waitFor("document.querySelector('[data-testid=android-incoming-invite]')?.textContent.includes('signs you out')===true")
                assertEquals("true", web.evaluate(scenario, "document.querySelector('[data-invite-connect]').textContent==='Use invitation'"))
                web.evaluate(scenario, "document.querySelector('[data-invite-dismiss]').click()")
                waitFor("!document.querySelector('[data-testid=android-incoming-invite]')&&!!document.querySelector('[data-testid=android-library]')")
                assertNull(IncomingTrackState.pending(context))
                assertEquals(member, core("/api/auth/state").getJSONObject("user").getString("id"))
                context.startActivity(send(second))
                waitFor("!!document.querySelector('[data-testid=android-incoming-invite]')")
                assertEquals(member, core("/api/auth/state").getJSONObject("user").getString("id"))
                web.evaluate(scenario, "document.querySelector('[data-invite-connect]').click()")
                waitFor("!!document.querySelector('[data-native-invite] input[autocomplete=username]')&&!document.querySelector('[data-testid=android-library]')")
                assertEquals(origin, connection.origin)
                assertNull(connection.sessionIdentity(connection.generation))
                val username = "incoming_" + java.util.UUID.randomUUID().toString().take(8)
                web.evaluate(scenario, "(()=>{const root=document.querySelector('[data-native-invite]');const user=root.querySelector('input[autocomplete=username]');user.value=${JSONObject.quote(username)};user.dispatchEvent(new Event('input',{bubbles:true}));for(const field of root.querySelectorAll('input[autocomplete=new-password]')){field.value='android-test';field.dispatchEvent(new Event('input',{bubbles:true}));}})()")
                waitFor("!!Array.from(document.querySelectorAll('[data-native-invite] button')).find(b=>b.textContent==='Create my account'&&!b.disabled)")
                web.evaluate(scenario, "document.querySelector('[data-native-invite] form').requestSubmit()")
                waitFor("!!document.querySelector('[data-testid=android-library]')&&!document.querySelector('[data-native-invite]')")
                assertEquals(username, core("/api/auth/state").getJSONObject("user").getString("username"))
            }
        } finally { connection.clearSession(true); clearPending() }
    }
}
