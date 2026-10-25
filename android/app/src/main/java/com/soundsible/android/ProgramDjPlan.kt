package com.soundsible.android

import kotlin.math.ceil
import kotlin.math.roundToLong

/** Conservative transition policy from stores/dj.ts, with occurrence ownership checked first. */
internal object ProgramDjPlan {
    /** `outPeriod`: seconds per beat of the outgoing song at its cue, as measured; 0 when unknown. */
    data class Proposal(val fromKey: String, val technique: ProgramMixCurve.Technique,
        val outCue: Double, val inCue: Double, val overlap: Double, val rate: Double,
        val confidence: Double, val phaseToleranceMs: Double = 5.0, val outPeriod: Double = 0.0,
        val echoDelaySeconds: Double? = null)
    data class Plan(val technique: ProgramMixCurve.Technique, val outCueUs: Long,
        val inCueUs: Long, val overlapUs: Long, val rate: Float, val phaseToleranceUs: Long,
        val echoDelaySeconds: Double? = null)
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
        val outCue = placeOutCue(proposed, earliest, latest, if (trusted) 4 * chained!!.outPeriod else 0.0)
        val inCue = if (trusted) chained!!.inCue.coerceIn(0.0, 86400.0) else 0.0
        val rate = if (trusted) chained!!.rate.coerceIn(0.94, 1.06).toFloat() else 1f
        val tolerance = chained?.phaseToleranceMs?.takeIf { it.isFinite() && it != 0.0 } ?: 5.0
        val echoDelay = chained?.echoDelaySeconds?.takeIf { trusted && chained.technique == ProgramMixCurve.Technique.ECHO_CUT && it.isFinite() && it > 0 && it <= 2 }
        val technique = if (!trusted) ProgramMixCurve.Technique.SAFE_FADE
            else if (chained!!.technique == ProgramMixCurve.Technique.ECHO_CUT && echoDelay == null) ProgramMixCurve.Technique.STRUCTURAL_FADE
            else chained.technique
        return Plan(technique,
            (outCue * 1000000).roundToLong(), (inCue * 1000000).roundToLong(),
            (overlap * 1000000).roundToLong(), rate, (tolerance.coerceIn(1.0, 12.0) * 1000).roundToLong(), echoDelay)
    }

    /**
     * A measured cue sits on a downbeat that `inCue` is aligned to. Moving it
     * into the allowed window by anything but whole bars would start the
     * incoming song between two beats; only when no whole bar fits is it
     * clamped like an unmeasured cue. Same rule as `placeOutCue` in
     * ui_web/src/lib/djCue.ts.
     */
    fun placeOutCue(proposed: Double, earliest: Double, latest: Double, barSeconds: Double): Double {
        if (proposed in earliest..latest) return proposed
        val clamped = proposed.coerceIn(earliest, latest)
        if (!(barSeconds.isFinite() && barSeconds in 0.8..8.0)) return clamped
        val moved = if (proposed > latest) proposed - ceil((proposed - latest) / barSeconds) * barSeconds
            else proposed + ceil((earliest - proposed) / barSeconds) * barSeconds
        return if (moved in earliest..latest) moved else clamped
    }
}
