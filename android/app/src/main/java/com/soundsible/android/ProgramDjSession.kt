package com.soundsible.android

import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.media3.common.*
import androidx.media3.common.audio.ChannelMixingAudioProcessor
import androidx.media3.common.audio.ChannelMixingMatrix
import androidx.media3.common.audio.SonicAudioProcessor
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.source.MediaSource
import java.nio.ByteBuffer

/** Executes an occurrence route on the native output clock, independent of the WebView. */
@UnstableApi
internal class ProgramDjSession(private val context: Context, private val generation: Long,
    private val ownsAccount: () -> Boolean, private val sources: MediaSource.Factory,
    private val tap: ProgramPcmTap, private val leveling: () -> Boolean,
    initial: List<Row>, startPositionMs: Long = 0, private val mixing: () -> Boolean = { true },
    private val changed: () -> Unit = {}) : AutoCloseable {
    data class Row(val item: MediaItem, val proposal: ProgramDjPlan.Proposal? = null)
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var closed = false
    private var route = initial.toList()
    private val indices = intArrayOf(0, -1)
    private var current = 0
    private var armed = false
    private var recovering = false
    private var pendingSince = 0L
    private var plan: ProgramDjPlan.Plan? = null
    @Volatile private var streams = arrayOfNulls<ProgramPcmTap.Stream>(2)
    private fun owns() = !closed && ownsAccount()
    private val output: ProgramMixOutput = ProgramMixOutput(context, ::owns) { bytes, rate, channels, frame ->
        streams[outputSlot(frame)]?.let { stream -> tap.offer(ByteBuffer.wrap(bytes), rate, channels, stream, frame) }
    }
    // The callback cannot run until a decoder writes PCM, after output construction.
    private fun outputSlot(frame: Long): Int = output.renderedInput(frame)
    private val decks = Array(2) { decoder(it) }
    private val rateReturns = Array(2) { index -> ProgramRateReturn(main, ::owns,
        { output.inputPositionUs(index) }, { decks[index].playbackParameters = PlaybackParameters(it, 1f) }) }
    val player: ProgramMixPlayer
    private val tick = object : Runnable {
        override fun run() {
            if (!owns()) return
            advance()
            main.postDelayed(this, 50)
        }
    }
    init {
        check(Looper.myLooper() == main.looper)
        require(initial.isNotEmpty() && initial.size <= ProgramQueue.LIMIT && startPositionMs >= 0)
        require(initial.all { it.item.mediaMetadata.extras?.getBoolean(ProgramQueue.PODCAST) != true })
        player = ProgramMixPlayer(context, output, decks, ::owns, ::decoderFailed,
            { slot -> ProgramMixPlayer.View(route.map { it.item }, indices[slot].takeIf { it in route.indices } ?: current) }, ::seek)
        load(0, 0, startPositionMs, 1f)
        main.post(tick)
    }
    private fun decoder(index: Int): ExoPlayer {
        val renderers = object : DefaultRenderersFactory(context) {
            override fun buildAudioSink(context: Context, enableFloatOutput: Boolean, enableAudioOutputPlaybackParams: Boolean): AudioSink {
                val channels = ChannelMixingAudioProcessor().apply {
                    putChannelMixingMatrix(ChannelMixingMatrix.createForConstantGain(1, 2))
                    putChannelMixingMatrix(ChannelMixingMatrix.createForConstantGain(2, 2))
                }
                val resampler = SonicAudioProcessor().apply { setOutputSampleRateHz(48000) }
                return DefaultAudioSink.Builder(context).setEnableFloatOutput(false)
                    .setEnableAudioOutputPlaybackParameters(false).setAudioProcessors(arrayOf(channels, resampler))
                    .setAudioOutputProvider(output.input(index)).build()
            }
        }
        return ExoPlayer.Builder(context, renderers).setMediaSourceFactory(sources)
            .setPlaybackLooper(output.playbackLooper).setWakeMode(C.WAKE_MODE_LOCAL).build()
    }
    private fun load(slot: Int, index: Int, positionMs: Long, rate: Float) {
        rateReturns[slot].close()
        indices[slot] = index
        val item = route[index].item
        streams = streams.copyOf().also { it[slot] = ProgramPcmTap.Stream(generation,
            item.mediaMetadata.extras?.getString(ProgramQueue.KEY) ?: "",
            item.mediaMetadata.extras?.getString(ProgramQueue.PROGRAM) ?: "",
            item.mediaMetadata.extras?.getString(ProgramQueue.SOURCE) ?: "", positionMs * 1000) }
        decks[slot].setMediaItem(item, positionMs)
        decks[slot].playbackParameters = PlaybackParameters(rate, 1f)
        decks[slot].prepare()
        if (player.playWhenReady && player.playbackSuppressionReason == Player.PLAYBACK_SUPPRESSION_REASON_NONE) decks[slot].play() else decks[slot].pause()
        level(slot)
    }
    private fun level(slot: Int) {
        val extras = decks[slot].currentMediaItem?.mediaMetadata?.extras ?: return
        fun fact(key: String) = extras.getDouble(key, Double.NaN).takeIf { it.isFinite() }
        output.setInputLevel(slot, ProgramLoudness.levelFor(ProgramLoudness.Facts(
            fact(ProgramPcmProcessor.LUFS), fact(ProgramPcmProcessor.PEAK), fact(ProgramPcmProcessor.DURATION)), leveling()))
    }
    private fun advance() {
        val slot = output.dominantInput()
        val selected = indices[slot]
        if (selected in route.indices && selected != current) {
            current = selected; player.routeChanged(); changed()
        }
        level(slot); if (indices[1 - slot] >= 0) level(1 - slot)
        val window = output.transition()
        if (armed && window != null) {
            if (output.positionUs() * 48000 / 1000000 < window.start + window.length) return
            val old = window.outgoing
            indices[old] = -1; streams = streams.copyOf().also { it[old] = null }
            decks[old].pause(); decks[old].stop(); decks[old].clearMediaItems()
            rateReturns[window.incoming].start(decks[window.incoming].playbackParameters.speed)
            armed = false; plan = null; pendingSince = 0
        }
        if (recovering) {
            val restored = output.restoredAt() ?: return
            if (output.positionUs() < restored * 1000000 / 48000 + 150000) return
            recovering = false
        }
        if (!player.playWhenReady || player.playbackSuppressionReason != Player.PLAYBACK_SUPPRESSION_REASON_NONE) {
            pendingSince = 0
            return
        }
        if (current + 1 >= route.size || armed) return
        val outgoing = decks[slot]
        val duration = outgoing.duration.takeIf { it > 0 } ?: return
        val resolved = plan ?: ProgramDjPlan.resolve(key(current), duration * 1000, route[current + 1].proposal, mixing()) ?: return
        val remainingUs = resolved.outCueUs - outgoing.currentPosition * 1000
        if (remainingUs > 45000000) return
        val standby = 1 - slot
        if (indices[standby] != current + 1) {
            plan = resolved
            // A silent preroll starts before the cue, so its seek target includes the tempo ratio.
            val prerollUs = minOf(4000000L, maxOf(0L, remainingUs - 500000), (resolved.inCueUs / resolved.rate).toLong())
            load(standby, current + 1, maxOf(0L, resolved.inCueUs - (prerollUs * resolved.rate).toLong()) / 1000, resolved.rate)
            pendingSince = android.os.SystemClock.elapsedRealtime()
            return
        }
        if (!output.readyInput(standby)) {
            if (pendingSince == 0L) pendingSince = android.os.SystemClock.elapsedRealtime()
            if (pendingSince > 0 && android.os.SystemClock.elapsedRealtime() - pendingSince > 15000) {
                // Never arm a missing decoder: the current input keeps its output clock.
                player.replaceInput(standby, decoder(standby)); indices[standby] = -1; pendingSince = 0
            }
            return
        }
        if (!mixing() || resolved.technique == ProgramMixCurve.Technique.DIRECT || outgoing.playbackState == Player.STATE_ENDED) {
            if (output.drainedInput(slot)) { output.blend(50, ProgramMixCurve.Technique.DIRECT); armed = true }
            return
        }
        val queuedUs = output.reservedPositionUs() - output.positionUs()
        val leadMs = ((remainingUs / outgoing.playbackParameters.speed - queuedUs) / 1000).toLong()
        if (leadMs > 0) {
            val seekMs = streams[standby]?.positionOffsetUs ?: 0
            val prerollMs = ((resolved.inCueUs - seekMs) / resolved.rate / 1000).toLong().coerceIn(0, minOf(4000, leadMs))
            output.arm(resolved.overlapUs / 1000, resolved.technique, leadMs.coerceAtMost(60000), prerollMs)
        } else output.blend(minOf(resolved.overlapUs / 1000, 1500), ProgramMixCurve.Technique.SAFE_FADE)
        armed = true
    }
    private fun key(index: Int) = route[index].item.mediaMetadata.extras?.getString(ProgramQueue.KEY) ?: ""
    private fun decoderFailed(slot: Int, error: PlaybackException): Boolean {
        val other = 1 - slot
        if (!owns() || indices[other] !in route.indices || !output.readyInput(other)) return false
        main.post {
            if (!owns()) return@post
            player.replaceInput(slot, decoder(slot)); indices[slot] = -1
            streams = streams.copyOf().also { it[slot] = null }
            armed = false; plan = null; pendingSince = 0; recovering = output.restoredAt() != null
            changed()
        }
        return true
    }
    fun seek(index: Int, positionMs: Long) {
        check(Looper.myLooper() == main.looper && owns())
        require(index in route.indices && positionMs >= 0)
        val resume = player.playWhenReady && player.playbackSuppressionReason == Player.PLAYBACK_SUPPRESSION_REASON_NONE
        output.pause(true); rateReturns.forEach { it.close() }
        decks.forEach { it.pause(); it.stop(); it.clearMediaItems() }
        output.resetTo(0)
        indices[0] = index; indices[1] = -1; current = index
        armed = false; recovering = false; plan = null; pendingSince = 0
        load(0, index, positionMs, 1f)
        output.pause(!resume); player.routeChanged(); changed()
    }
    /** Append/refill never replaces either committed occurrence. */
    fun append(rows: List<Row>) {
        require(owns() && route.size + rows.size <= ProgramQueue.LIMIT)
        route = route + rows; player.routeChanged(); changed()
    }
    override fun close() {
        check(Looper.myLooper() == main.looper)
        if (closed) return
        main.removeCallbacks(tick); rateReturns.forEach { it.close() }
        player.release(); closed = true
    }
}
