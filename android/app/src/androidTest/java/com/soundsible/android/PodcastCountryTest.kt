package com.soundsible.android

import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

/** Country and charts through the real native WebView/HTTP bridge; transport is unchanged. */
class PodcastCountryTest {
    @Test fun countryChartsAndSettings() {
        val origin = InstrumentationRegistry.getArguments().getString("fixtureOrigin")!!
        val connection = EngineConnection.shared(InstrumentationRegistry.getInstrumentation().targetContext)
        connection.clearSession(true)
        val epoch = connection.configure(origin)
        fun core(path: String, method: String = "GET", body: JSONObject? = null): JSONObject = connection.execute(path, method,
            body?.toString()?.toRequestBody("application/json".toMediaType()), emptyMap(), epoch, "country-${java.util.UUID.randomUUID()}", 20000).use {
                val text = it.body?.string().orEmpty(); check(it.isSuccessful) { "$path ${it.code}: $text" }; JSONObject(text)
            }
        core("/api/auth/login", "POST", JSONObject().put("username", "member").put("password", "android-test"))
        core("/api/discovery/settings", "PATCH", JSONObject().put("podcast_country", "es"))
        val web = StartupTest()
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                fun waitFor(condition: String) {
                    val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(45)
                    while (System.nanoTime() < until) { if (web.evaluate(scenario, condition) == "true") return; Thread.sleep(100) }
                    fail("Podcast country: $condition; " + web.evaluate(scenario, "document.body.innerText"))
                }
                waitFor("!!document.querySelector('[data-android-podcasts]')&&!document.documentElement.hasAttribute('data-booting')")
                web.evaluate(scenario, "localStorage.setItem('lang','en')"); scenario.recreate()
                waitFor("!!document.querySelector('[data-android-podcasts]')&&!document.documentElement.hasAttribute('data-booting')")
                web.evaluate(scenario, "document.querySelector('[data-android-podcasts]').click()")
                val picker = "document.querySelector('[data-testid=android-podcast-directory] header select')"
                waitFor("$picker?.value==='es'&&document.body.innerText.includes('Popular episodes in Spain')&&document.body.innerText.includes('fixture ranked episode')")
                web.evaluate(scenario, "$picker.value='us';$picker.dispatchEvent(new Event('change',{bubbles:true}))")
                waitFor("$picker?.value==='us'&&document.body.innerText.includes('Popular podcasts in United States')")
                assertEquals("us", core("/api/discovery/settings").getString("podcast_country"))
                val resolved = core("/api/discovery/podcasts/episode?show_id=900003&episode_id=900004&country=us")
                assertEquals("directory-episode-guid", resolved.getJSONObject("episode").getString("guid"))
                web.evaluate(scenario, "document.querySelector('[data-android-settings]').click()")
                waitFor("!!document.querySelector('[data-android-settings-playback]')")
                web.evaluate(scenario, "document.querySelector('[data-android-settings-playback]').click()")
                val setting = "document.querySelector('[data-setting=podcast-country] select')"
                waitFor("$setting?.value==='us'")
                web.evaluate(scenario, "$setting.value='es';$setting.dispatchEvent(new Event('change',{bubbles:true}))")
                waitFor("$setting?.value==='es'")
                assertEquals("es", core("/api/discovery/settings").getString("podcast_country"))
            }
        } finally { connection.clearSession(true) }
    }
}
