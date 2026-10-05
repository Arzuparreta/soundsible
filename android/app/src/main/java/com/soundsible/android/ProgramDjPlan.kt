package com.soundsible.android

import kotlin.math.roundToLong

/** Conservative transition policy from stores/dj.ts, with occurrence ownership checked first. */
internal object ProgramDjPlan {
    data class Proposal(val fromKey: String, val technique: ProgramMixCurve.Technique,
        val outCue: Double, val inCue: Double, val overlap: Double, val rate: Double,
        val confidence: Double, val phaseToleranceMs: Double = 5.0)
    data class Plan(val technique: ProgramMixCurve.Technique, val outCueUs: Long,
        val inCueUs: Long, val overlapUs: Long, val rate: Float, val phaseToleranceUs: Long)
    fun resolve(fromKey: String, durationUs: Long, proposal: Proposal?, mixing: Boolean): Plan? {
        if (durationUs <= 4000000 || durationUs > 86400000000 || fromKey.isBlank()) return null
        if (!mixing) return Plan(ProgramMixCurve.Technique.DIRECT, durationUs, 0, 0, 1f, 5000)
        val chained = proposal?.takeIf { it.fromKey == fromKey }
        val trusted = chained?.let { it.confidence.isFinite() && it.confidence >= 0.35 &&
            listOf(it.outCue, it.inCue, it.overlap, it.rate).all(Double::isFinite) } == true
        val duration = durationUs / 1000000.0
        val requested = chained?.overlap?.takeIf { it.isFinite() } ?: 6.0
        val overlap = maxOf(1.5, minOf(if (trusted) requested else minOf(requested, 6.0), duration * 0.25, 48.0))
        val latest = duration - overlap - 1
        if (latest <= 0) return null
        val earliest = minOf(90.0, duration * 0.6, latest)
        val proposed = chained?.outCue?.takeIf { it.isFinite() && it > 0 } ?: latest
        val outCue = proposed.coerceIn(earliest, latest)
        val inCue = if (trusted) chained!!.inCue.coerceIn(0.0, 86400.0) else 0.0
        val rate = if (trusted) chained!!.rate.coerceIn(0.94, 1.06).toFloat() else 1f
        val tolerance = chained?.phaseToleranceMs?.takeIf { it.isFinite() && it != 0.0 } ?: 5.0
        return Plan(if (trusted) chained!!.technique else ProgramMixCurve.Technique.SAFE_FADE,
            (outCue * 1000000).roundToLong(), (inCue * 1000000).roundToLong(),
            (overlap * 1000000).roundToLong(), rate, (tolerance.coerceIn(1.0, 12.0) * 1000).roundToLong())
    }
}
