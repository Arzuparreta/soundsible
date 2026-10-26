package com.soundsible.android

import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.round
import kotlin.math.ceil
import kotlin.math.roundToLong

/** Conservative transition policy from stores/dj.ts, with occurrence ownership checked first. */
internal object ProgramDjPlan {
    /** `outPeriod`: seconds per beat of the outgoing song at its cue, as measured; 0 when unknown. */
    data class Proposal(val fromKey: String, val technique: ProgramMixCurve.Technique,
        val outCue: Double, val inCue: Double, val overlap: Double, val rate: Double,
        val confidence: Double, val phaseToleranceMs: Double = 5.0, val outPeriod: Double = 0.0,
        val echoDelaySeconds: Double? = null, val metricSync: JSONObject? = null)
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
        val placement = metricCuePlacement(proposed, earliest, latest, if (trusted) chained else null, overlap)
        val outCue = placement.first
        val metricFallback = trusted && chained!!.technique in setOf(ProgramMixCurve.Technique.BASS_SWAP,
            ProgramMixCurve.Technique.FILTER_BLEND, ProgramMixCurve.Technique.LONG_BLEND) && !placement.second
        val inCue = if (trusted) chained!!.inCue.coerceIn(0.0, 86400.0) else 0.0
        val rate = if (trusted && !metricFallback) chained!!.rate.coerceIn(0.94, 1.06).toFloat() else 1f
        val tolerance = chained?.phaseToleranceMs?.takeIf { it.isFinite() && it != 0.0 } ?: 5.0
        val echoDelay = chained?.echoDelaySeconds?.takeIf { trusted && chained.technique == ProgramMixCurve.Technique.ECHO_CUT && it.isFinite() && it > 0 && it <= 2 }
        val technique = if (!trusted) ProgramMixCurve.Technique.SAFE_FADE
            else if (metricFallback) ProgramMixCurve.Technique.STRUCTURAL_FADE
            else if (chained!!.technique == ProgramMixCurve.Technique.ECHO_CUT && echoDelay == null) ProgramMixCurve.Technique.STRUCTURAL_FADE
            else chained.technique
        return Plan(technique,
            (outCue * 1000000).roundToLong(), (inCue * 1000000).roundToLong(),
            (overlap * 1000000).roundToLong(), rate, (tolerance.coerceIn(1.0, 12.0) * 1000).roundToLong(), echoDelay)
    }

    /** Missing bar field is the old four-pulse prior; explicit null is unknown. */
    fun barSeconds(proposal: Proposal?): Double {
        val sync = proposal?.metricSync
        if (sync?.has("out_bar_seconds") == true) {
            return sync.optDouble("out_bar_seconds", Double.NaN).takeIf { it.isFinite() && it in 0.2..32.0 } ?: 0.0
        }
        return (4 * (proposal?.outPeriod ?: 0.0)).takeIf { it.isFinite() && it > 0 } ?: 0.0
    }

    /** Common cycles the server may send: m outgoing beats = n incoming beats (shared/dj/timing.py). */
    private val CYCLES = setOf(1 to 1, 1 to 2, 2 to 1, 2 to 3, 3 to 2, 3 to 4, 4 to 3, 1 to 3, 3 to 1, 1 to 4, 4 to 1)

    /**
     * A relocated measured plan keeps its complete coverage and its phase.
     * Both cues sit on a first beat and the players hold the common cycle
     * (`cycle_beats`). The cue moves only by whole `relocation_seconds`:
     * whole outgoing bars that are also whole cycles. `bars` also checks the
     * confirmed bars, of equal executed length. Same rule as
     * `metricCuePlacement` in ui_web/src/lib/djCue.ts.
     */
    fun metricCuePlacement(proposed: Double, earliest: Double, latest: Double, proposal: Proposal?, overlap: Double): Pair<Double, Boolean> {
        val sync = proposal?.metricSync
        val bar = barSeconds(proposal)
        val fallback = placeOutCue(proposed, earliest, latest, bar)
        if (sync?.has("alignment") != true) return fallback to (sync?.has("out_bar_seconds") != true)
        val alignment = sync.optString("alignment")
        if (alignment != "bars" && alignment != "beats") return fallback to false
        val out = sync.optJSONObject("out_metre") ?: return fallback to false
        val incoming = sync.optJSONObject("in_metre") ?: return fallback to false
        val cycle = sync.optJSONArray("cycle_beats") ?: return fallback to false
        if (cycle.length() != 2) return fallback to false
        val m = cycle.optInt(0, 0)
        val n = cycle.optInt(1, 0)
        if ((m to n) !in CYCLES || cycle.optDouble(0) != m.toDouble() || cycle.optDouble(1) != n.toDouble()) return fallback to false
        val step = sync.optDouble("relocation_seconds", Double.NaN)
        if (!(step > 0)) return fallback to false
        val outPeriod = sync.optDouble("out_period", Double.NaN)
        val inPeriod = sync.optDouble("in_period", Double.NaN)
        val left = maxOf(earliest, out.optDouble("start", Double.NaN))
        val right = minOf(latest, out.optDouble("end", Double.NaN) - overlap)
        val inStart = incoming.optDouble("start", Double.NaN)
        val inEnd = incoming.optDouble("end", Double.NaN)
        if (!listOf(left, right, inStart, inEnd).all(Double::isFinite) || left > right) return fallback to false
        val cue = placeOutCue(proposed, left, right, step)
        val tolerance = minOf(0.005, sync.optDouble("phase_tolerance_ms", 5.0) / 1000)
        val pulseRatio = inPeriod * n / (outPeriod * m)
        if (!listOf(proposal.rate, pulseRatio, tolerance).all(Double::isFinite) || proposal.rate !in 0.94..1.06 ||
            outPeriod <= 0 || inPeriod <= 0 || tolerance < 0 ||
            abs(proposal.rate / pulseRatio - 1) * overlap > tolerance) return fallback to false
        if (alignment == "bars" || !sync.isNull("out_bar_seconds") || !sync.isNull("in_bar_seconds")) {
            val inBar = sync.optDouble("in_bar_seconds", Double.NaN)
            if (!(bar > 0) || !inBar.isFinite() || inBar <= 0 || abs(inBar / proposal.rate / bar - 1) * overlap > tolerance) return fallback to false
        }
        val phaseError = abs(cue - proposed - round((cue - proposed) / step) * step)
        return cue to (phaseError <= tolerance && proposal.inCue >= inStart - tolerance &&
            proposal.inCue + overlap * proposal.rate <= inEnd + tolerance)
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
        if (!(barSeconds.isFinite() && barSeconds in 0.2..32.0)) return clamped
        val moved = if (proposed > latest) proposed - ceil((proposed - latest) / barSeconds) * barSeconds
            else proposed + ceil((earliest - proposed) / barSeconds) * barSeconds
        return if (moved in earliest..latest) moved else clamped
    }
}
