package com.soundsible.android

import android.content.Context
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import androidx.media3.common.*
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/** MediaSession view of two private decoder inputs; neither decoder owns device focus. */
@UnstableApi
internal class ProgramMixPlayer(context: Context, private val output: ProgramMixOutput,
    private val decks: Array<ExoPlayer>, private val owns: () -> Boolean,
    private val onDecoderError: (Int, PlaybackException) -> Boolean = { _, _ -> false },
    private val snapshot: ((Int) -> View)? = null,
    private val seekRoute: ((Int, Long) -> Unit)? = null) : SimpleBasePlayer(Looper.getMainLooper()) {
    data class View(val items: List<MediaItem>, val current: Int)
    fun routeChanged() { invalidateState() }
    fun replaceInput(index: Int, next: ExoPlayer) {
        check(Looper.myLooper() == applicationLooper && !closed)
        require(index in 0..1 && next.applicationLooper == applicationLooper && !next.playWhenReady)
        decks[index].removeListener(listeners[index]); decks[index].release()
        next.setAudioAttributes(attributes, false); next.setHandleAudioBecomingNoisy(false)
        decks[index] = next; next.addListener(listeners[index])
    }
    private val main = Handler(applicationLooper)
    private var requested = false
    private var suppressed = false
    private var localVolume = 1f
    private var duck = 1f
    private var closed = false
    private var failure: PlaybackException? = null
    private var reason = Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST
    private val attributes = AudioAttributes.Builder().setUsage(C.USAGE_MEDIA)
        .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build()
    private val focus = ProgramAudioFocus(context, main, ::focusChanged) {
        setRequested(false, Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY)
    }
    private val listeners = Array(2) { index -> object : Player.Listener {
        override fun onPlayerError(error: PlaybackException) {
            if (closed || !owns()) return
            if (!onDecoderError(index, error)) {
                failure = error
                setRequested(false, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
            }
            invalidateState()
        }
        override fun onEvents(player: Player, events: Player.Events) { if (!closed) invalidateState() }
    } }
    private val tick = object : Runnable {
        override fun run() {
            if (closed) return
            if (!owns()) {
                setRequested(false, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
                decks.forEach { it.stop() }
                return
            }
            output.error()?.let {
                if (failure == null) {
                    failure = PlaybackException("Programme output failed", it, PlaybackException.ERROR_CODE_AUDIO_TRACK_WRITE_FAILED)
                    setRequested(false, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
                }
            }
            invalidateState()
            main.postDelayed(this, 50)
        }
    }
    init {
        check(Looper.myLooper() == applicationLooper)
        require(decks.size == 2 && decks.all { it.applicationLooper == applicationLooper && !it.playWhenReady })
        output.pause(true)
        decks.forEachIndexed { index, deck ->
            deck.setAudioAttributes(attributes, false)
            deck.setHandleAudioBecomingNoisy(false)
            deck.addListener(listeners[index])
        }
        main.post(tick)
    }
    override fun getState(): State {
        val slots = decks.indices.filter { decks[it].currentMediaItem != null }
        val slot = output.dominantInput().takeIf { it in slots } ?: slots.firstOrNull() ?: 0
        val deck = decks[slot]
        val view = snapshot?.invoke(slot) ?: View(slots.map { decks[it].currentMediaItem!! }, slots.indexOf(slot))
        val playlist = view.items.mapIndexed { index, item ->
            val duration = slots.firstOrNull { decks[it].currentMediaItem == item }?.let { decks[it].duration }
                ?.takeIf { it >= 0 } ?: item.mediaMetadata.extras?.getDouble(ProgramPcmProcessor.DURATION, Double.NaN)
                ?.takeIf { it.isFinite() && it >= 0 }?.times(1000)?.toLong() ?: C.TIME_UNSET
            MediaItemData.Builder(item.mediaMetadata.extras?.getString(ProgramQueue.KEY) ?: "row-$index")
                .setMediaItem(item).setDurationUs(if (duration == C.TIME_UNSET) C.TIME_UNSET else duration * 1000)
                .setIsSeekable(true).build()
        }
        val commands = Player.Commands.Builder().addAll(Player.COMMAND_PLAY_PAUSE, Player.COMMAND_PREPARE,
            Player.COMMAND_STOP, Player.COMMAND_RELEASE, Player.COMMAND_GET_CURRENT_MEDIA_ITEM,
            Player.COMMAND_GET_TIMELINE, Player.COMMAND_GET_METADATA, Player.COMMAND_GET_VOLUME,
            Player.COMMAND_SET_VOLUME, Player.COMMAND_GET_AUDIO_ATTRIBUTES)
        if (slots.isNotEmpty() && deck.isCurrentMediaItemSeekable) commands.add(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM)
        if (seekRoute != null && view.items.isNotEmpty()) commands.addAll(Player.COMMAND_SEEK_TO_MEDIA_ITEM,
            Player.COMMAND_SEEK_TO_DEFAULT_POSITION, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
            Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM, Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_PREVIOUS)
        val state = if (slots.isEmpty() || failure != null) Player.STATE_IDLE
            else if (deck.playbackState == Player.STATE_ENDED && !output.drainedInput(slot)) Player.STATE_READY else deck.playbackState
        return State.Builder().setAvailableCommands(commands.build()).setPlaylist(playlist)
            .setCurrentMediaItemIndex(if (view.items.isEmpty()) C.INDEX_UNSET else view.current)
            .setPlayWhenReady(requested, reason).setPlaybackState(state)
            .setPlaybackSuppressionReason(if (suppressed) Player.PLAYBACK_SUPPRESSION_REASON_TRANSIENT_AUDIO_FOCUS_LOSS else Player.PLAYBACK_SUPPRESSION_REASON_NONE)
            .setPlayerError(failure).setAudioAttributes(attributes).setVolume(localVolume)
            .setContentPositionMs { deck.currentPosition }.setContentBufferedPositionMs { deck.bufferedPosition }
            .setTotalBufferedDurationMs { deck.totalBufferedDuration }.build()
    }
    private fun setRequested(value: Boolean, changeReason: Int) {
        requested = value && owns() && !closed && failure == null
        reason = changeReason
        suppressed = false; duck = 1f
        if (requested && !focus.acquire()) {
            requested = false
            reason = Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS
            focus.abandon()
        } else if (!requested) focus.abandon()
        output.setVolume(localVolume)
        output.pause(!requested)
        invalidateState()
    }
    private fun focusChanged(change: Int) {
        when (change) {
            AudioManager.AUDIOFOCUS_GAIN -> { suppressed = false; duck = 1f }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> suppressed = true
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> duck = 0.2f
            AudioManager.AUDIOFOCUS_LOSS -> { setRequested(false, Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS); return }
        }
        output.setVolume(localVolume * duck)
        output.pause(!requested || suppressed)
        invalidateState()
    }
    override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
        setRequested(playWhenReady, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
        return Futures.immediateVoidFuture()
    }
    override fun handlePrepare(): ListenableFuture<*> {
        if (owns()) {
            failure = null
            decks.filter { it.currentMediaItem != null }.forEach { it.prepare(); it.play() }
        }
        return Futures.immediateVoidFuture()
    }
    override fun handleStop(): ListenableFuture<*> {
        setRequested(false, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
        decks.forEach { it.pause(); it.stop() }
        return Futures.immediateVoidFuture()
    }
    override fun handleSetVolume(volume: Float, flags: Int): ListenableFuture<*> {
        localVolume = volume
        output.setVolume(volume * duck)
        return Futures.immediateVoidFuture()
    }
    override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
        if (seekRoute != null) { seekRoute.invoke(mediaItemIndex, if (positionMs == C.TIME_UNSET) 0 else positionMs); return Futures.immediateVoidFuture() }
        val slots = decks.indices.filter { decks[it].currentMediaItem != null }
        val slot = output.dominantInput()
        require(mediaItemIndex in slots.indices && slots[mediaItemIndex] == slot)
        require(output.transition() == null || output.cancelArmed()) { "Seek requires the transition controller to retire the other input" }
        decks[slot].seekTo(positionMs)
        return Futures.immediateVoidFuture()
    }
    override fun handleRelease(): ListenableFuture<*> {
        output.pause(true)
        closed = true; requested = false
        main.removeCallbacks(tick)
        focus.close()
        decks.forEachIndexed { index, deck -> deck.removeListener(listeners[index]); deck.release() }
        output.close()
        return Futures.immediateVoidFuture()
    }
}
