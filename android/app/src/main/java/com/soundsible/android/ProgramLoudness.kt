package com.soundsible.android

import kotlin.math.log10
import kotlin.math.pow

/** Same policy as lib/loudness.ts; facts and exact playback context belong to the caller. */
internal object ProgramLoudness {
    data class Facts(val lufs: Double? = null, val peakDbtp: Double? = null, val duration: Double? = null)
    data class Reference(val lufs: Double, val peakDbtp: Double)
    fun measured(lufs: Double?, peakDbtp: Double?): Boolean =
        lufs != null && peakDbtp != null && lufs.isFinite() && peakDbtp.isFinite() &&
            lufs > -69 && lufs <= 5 && peakDbtp >= -70 && peakDbtp <= 12
    fun gainDb(lufs: Double?, peakDbtp: Double?): Double {
        if (!measured(lufs, peakDbtp)) return 0.0
        val wanted = (-18 - lufs!!).coerceIn(-20.0, 6.0)
        return minOf(wanted, -1 - peakDbtp!!).coerceIn(-20.0, 6.0)
    }
    fun linear(db: Double): Double = if (!db.isFinite()) 1.0 else 10.0.pow(db / 20).coerceIn(0.05, 4.0)
    fun albumReference(tracks: List<Facts>): Reference? {
        var energy = 0.0; var seconds = 0.0; var peak = Double.NEGATIVE_INFINITY; var measured = 0
        for (track in tracks) {
            val lufs = track.lufs; val tp = track.peakDbtp
            if (lufs == null || tp == null || !lufs.isFinite() || !tp.isFinite() || lufs <= -69) continue
            val duration = track.duration?.takeIf { it.isFinite() && it > 0 } ?: 1.0
            energy += duration * 10.0.pow((lufs + 0.691) / 10); seconds += duration
            peak = maxOf(peak, tp); measured++
        }
        if (measured == 0 || measured < tracks.size * 0.9 || seconds <= 0) return null
        return Reference(-0.691 + 10 * log10(energy / seconds), peak)
    }
    fun levelFor(track: Facts?, enabled: Boolean, shuffle: Boolean = false,
        contextKind: String? = null, contextId: String? = null, siblings: List<Facts> = emptyList()): Double {
        if (track == null || !enabled) return 1.0
        if (!shuffle && contextKind == "album" && !contextId.isNullOrEmpty() && siblings.isNotEmpty()) {
            albumReference(siblings)?.let { return linear(gainDb(it.lufs, it.peakDbtp)) }
        }
        return if (!measured(track.lufs, track.peakDbtp)) linear(-4.0) else linear(gainDb(track.lufs, track.peakDbtp))
    }
}
