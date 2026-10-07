package com.soundsible.android
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit
/** Recommended shows from the real engine: "not interested" is recorded, subscribing moves the show to your shows. HTTP only (no transport change). */
class PodcastTopTest {
    @Test fun httpPodcastTop() {
        val origin = InstrumentationRegistry.getArguments().getString("fixtureOrigin")!!
        val connection = EngineConnection.shared(InstrumentationRegistry.getInstrumentation().targetContext)
        connection.clearSession(true); val epoch = connection.configure(origin)
        fun core(path: String, method: String = "GET", body: JSONObject? = null): JSONObject = connection.execute(path, method,
            body?.toString()?.toRequestBody("application/json".toMediaType()), emptyMap(), epoch, "podcast-top-${java.util.UUID.randomUUID()}", 20000).use {
                val text = it.body?.string().orEmpty(); check(it.isSuccessful) { "$path ${it.code}: $text" }; if (text.isBlank()) JSONObject() else JSONObject(text)
            }
        fun subscription(): JSONObject? { val rows = core("/api/library").optJSONArray("podcast_subscriptions") ?: return null
            return (0 until rows.length()).map(rows::getJSONObject).firstOrNull { it.optString("rss_url").endsWith("/directory/feed.xml") } }
        fun unsubscribe() { subscription()?.let { core("/api/podcasts/subscriptions/" + it.getString("id"), "DELETE") } }
        core("/api/auth/login", "POST", JSONObject().put("username", "member").put("password", "android-test"))
        unsubscribe()
        val web = StartupTest()
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                fun waitFor(condition: String) {
                    val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(45)
                    while (System.nanoTime() < until) { if (web.evaluate(scenario, condition) == "true") return; Thread.sleep(100) }
                    fail("Podcast top: $condition; " + web.evaluate(scenario, "document.body.innerText"))
                }
                fun menuButton(label: String) = "Array.from(document.querySelectorAll('[role=dialog] button')).find(b=>b.textContent.trim()===${JSONObject.quote(label)})"
                val topRow = "Array.from(document.querySelectorAll('[data-podcast-top] [data-music-list-row]')).find(r=>r.textContent.includes('fixture top podcast'))"
                waitFor("!!document.querySelector('[data-testid=android-library]')&&!document.documentElement.hasAttribute('data-booting')")
                web.evaluate(scenario, "localStorage.setItem('lang','en')"); scenario.recreate()
                waitFor("!!document.querySelector('[data-android-podcasts]')&&!document.documentElement.hasAttribute('data-booting')")
                web.evaluate(scenario, "document.querySelector('[data-android-podcasts]').click()")
                waitFor("!!$topRow?.querySelector('[data-row-menu]')")

                // "Not interested" reaches the engine and offers an undo.
                web.evaluate(scenario, "$topRow.querySelector('[data-row-menu]').click()")
                waitFor("!!${menuButton("Not interested")}&&!!${menuButton("Subscribe")}")
                web.evaluate(scenario, "${menuButton("Not interested")}.click()")
                waitFor("document.body.innerText.includes('less likely')")

                // Subscribing from the list: confirmed by Core, then shown under your shows and no longer recommended.
                web.evaluate(scenario, "$topRow.querySelector('[data-row-menu]').click()")
                waitFor("!!${menuButton("Subscribe")}"); web.evaluate(scenario, "${menuButton("Subscribe")}.click()")
                val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
                while (subscription() == null && System.nanoTime() < until) Thread.sleep(200)
                assertNotNull("Core never stored the subscription", subscription())
                waitFor("!$topRow")
            }
        } finally { runCatching { unsubscribe() }; connection.clearSession(true) }
    }
}
