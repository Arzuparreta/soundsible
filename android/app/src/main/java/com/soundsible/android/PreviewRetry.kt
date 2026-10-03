package com.soundsible.android

import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/** One explicit attempt, shared across range loads. Monotonic budget; wall clock only for HTTP dates/UI. */
class PreviewRetry(private val monotonic: () -> Long, private val wall: () -> Long) {
    private var firstFailure: Long? = null
    var attempts = 0; private set
    var notBefore = 0L; private set
    var pending = false; private set
    @Synchronized fun delay(status: Int, header: String?): Long? {
        if (status != 429 && status != 503) return null
        val now = monotonic()
        val first = firstFailure ?: now.also { firstFailure = it }
        val fallback = if (attempts == 0) 2000L else 4000L
        val seconds = header?.trim()?.toLongOrNull()?.takeIf { it >= 0 }
        val date = if (seconds == null && header != null) try {
            SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US).apply { timeZone = TimeZone.getTimeZone("GMT"); isLenient = false }.parse(header)?.time
        } catch (_: Exception) { null } else null
        val wait = seconds?.coerceAtMost(Long.MAX_VALUE / 1000)?.times(1000) ?: date?.let { (it - wall()).coerceAtLeast(0) } ?: fallback
        notBefore = now + wait.coerceAtMost(Long.MAX_VALUE - now)
        pending = attempts < 2 && wait <= 30000 && now - first <= 30000 - wait
        if (!pending) return null
        attempts++
        return wait
    }
    @Synchronized fun loaded() { pending = false }
    @Synchronized fun remaining(): Long = (notBefore - monotonic()).coerceAtLeast(0)
    @Synchronized fun retry() { require(remaining() == 0L) { "RETRY_AFTER" }; firstFailure = null; attempts = 0; pending = false }
}
