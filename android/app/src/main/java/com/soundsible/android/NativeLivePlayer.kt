package com.soundsible.android

import android.content.Context
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import androidx.media3.common.*
import androidx.media3.common.util.UnstableApi
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONObject
import org.webrtc.AudioTrackSink
import org.webrtc.PeerConnection
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors

/** Live has one MediaSession/focus owner. Received PCM never enters the programme tap. */
@UnstableApi
internal class NativeLivePlayer(
    private val context: Context,
    private val connection: EngineConnection,
    private val room: JSONObject,
) : SimpleBasePlayer(Looper.getMainLooper()) {
    private val epoch = connection.generation
    private val main = Handler(applicationLooper)
    private val worker = Executors.newSingleThreadExecutor { task -> Thread(task, "soundsible-live-listener").apply { isDaemon = true } }
    private var peer: LivePeer? = null
    private var requested = false
    private var suppressed = false
    private var duck = 1f
    private var volumeValue = 1f
    private var state = Player.STATE_IDLE
    private var closed = false
    private var failure: PlaybackException? = null
    private var reason = Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST
    private var startedAt = 0L
    private val attributes = AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build()
    private val focus = ProgramAudioFocus(context, main, ::focusChanged) { setRequested(false, Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY) }
    private val reset: () -> Unit = { main.post { if (!closed) stopOutput() } }
    private val item = MediaItem.Builder().setMediaId("soundsible:live:${room.getString("id")}").setMediaMetadata(
        MediaMetadata.Builder().setTitle(room.optString("title")).setArtist(room.optJSONObject("host")?.optString("display_name").orEmpty())
            .setIsPlayable(true).setExtras(android.os.Bundle().apply {
                putString(ProgramQueue.SOURCE, "live"); putString(ProgramQueue.KEY, "live:${room.getString("id")}")
                putString(ProgramQueue.PROGRAM, "live:${room.getString("id")}")
            }).build()).build()
    init { connection.resetListeners.add(reset) }
    override fun getState(): State = State.Builder()
        .setAvailableCommands(Player.Commands.Builder().addAll(Player.COMMAND_PLAY_PAUSE, Player.COMMAND_PREPARE,
            Player.COMMAND_STOP, Player.COMMAND_RELEASE, Player.COMMAND_GET_CURRENT_MEDIA_ITEM,
            Player.COMMAND_GET_TIMELINE, Player.COMMAND_GET_METADATA, Player.COMMAND_GET_VOLUME,
            Player.COMMAND_SET_VOLUME, Player.COMMAND_GET_AUDIO_ATTRIBUTES, Player.COMMAND_SET_MEDIA_ITEM, Player.COMMAND_CHANGE_MEDIA_ITEMS).build())
        .setPlaylist(listOf(MediaItemData.Builder(item.mediaId).setMediaItem(item).setIsSeekable(false).setIsDynamic(true).build()))
        .setCurrentMediaItemIndex(0).setPlaybackState(state).setPlayWhenReady(requested, reason)
        .setPlaybackSuppressionReason(if (suppressed) Player.PLAYBACK_SUPPRESSION_REASON_TRANSIENT_AUDIO_FOCUS_LOSS else Player.PLAYBACK_SUPPRESSION_REASON_NONE)
        .setAudioAttributes(attributes).setVolume(volumeValue).setPlayerError(failure)
        .setContentPositionMs { if (startedAt == 0L) 0L else (android.os.SystemClock.elapsedRealtime() - startedAt).coerceAtLeast(0) }
        .build()
    private fun current() = !closed && epoch == connection.generation
    private fun audible() = requested && !suppressed && state == Player.STATE_READY && current()
    private fun gain() { peer?.setVolume(if (audible()) (volumeValue * duck).toDouble() else 0.0) }
    private fun setRequested(value: Boolean, changeReason: Int) {
        requested = value && current() && failure == null; reason = changeReason
        suppressed = false; duck = 1f
        if (requested && !focus.acquire()) { requested = false; reason = Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS; focus.abandon() }
        else if (!requested) focus.abandon()
        gain(); invalidateState()
    }
    private fun focusChanged(change: Int) {
        when (change) {
            AudioManager.AUDIOFOCUS_GAIN -> { suppressed = false; duck = 1f }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> suppressed = true
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> duck = .2f
            AudioManager.AUDIOFOCUS_LOSS -> { setRequested(false, Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS); return }
        }
        gain(); invalidateState()
    }
    override fun handlePrepare(): ListenableFuture<*> {
        if (!current() || peer != null && failure == null) return Futures.immediateVoidFuture()
        val previous = peer; peer = null
        if (previous != null) worker.execute { previous.close() }
        failure = null; state = Player.STATE_BUFFERING; startedAt = android.os.SystemClock.elapsedRealtime()
        val sink = AudioTrackSink { data, bits, rate, channels, frames, stamp ->
            for (observer in decodedObservers) observer.onData(data.asReadOnlyBuffer(), bits, rate, channels, frames, stamp)
        }
        lateinit var next: LivePeer
        next = LivePeer(context, connection, room.getString("whep_url"), null, false, { phase -> main.post {
            if (current() && peer === next) {
                when (phase) {
                    PeerConnection.PeerConnectionState.CONNECTED -> state = Player.STATE_READY
                    PeerConnection.PeerConnectionState.DISCONNECTED -> state = Player.STATE_BUFFERING
                    PeerConnection.PeerConnectionState.FAILED -> {
                        failure = PlaybackException("Live disconnected", null, PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED)
                        state = Player.STATE_IDLE; setRequested(false, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
                    }
                    else -> Unit
                }
                gain(); invalidateState()
            }
        } }, sink, playDecodedAudio = true)
        next.setVolume(0.0); peer = next
        worker.execute {
            try { next.start() }
            catch (error: Exception) { main.post { if (current() && peer === next) {
                failure = PlaybackException("Live unavailable", error, PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED)
                state = Player.STATE_IDLE; setRequested(false, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST); invalidateState()
            } } }
        }
        invalidateState(); return Futures.immediateVoidFuture()
    }
    override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
        if (playWhenReady && state == Player.STATE_IDLE && (peer == null || failure != null)) handlePrepare()
        setRequested(playWhenReady, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST); return Futures.immediateVoidFuture()
    }
    override fun handleSetVolume(volume: Float): ListenableFuture<*> { volumeValue = volume; gain(); invalidateState(); return Futures.immediateVoidFuture() }
    private fun stopOutput() {
        setRequested(false, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
        state = Player.STATE_IDLE
        val previous = peer; peer = null
        if (previous != null) worker.execute { previous.close() }
        invalidateState()
    }
    override fun handleStop(): ListenableFuture<*> { stopOutput(); return Futures.immediateVoidFuture() }
    override fun handleRelease(): ListenableFuture<*> {
        stopOutput(); closed = true; connection.resetListeners.remove(reset); focus.close(); main.removeCallbacksAndMessages(null); worker.shutdown()
        return Futures.immediateVoidFuture()
    }
    companion object {
        /** In-process decoded-audio diagnostics only; no JS, IPC or programme recapture. */
        internal val decodedObservers = CopyOnWriteArraySet<AudioTrackSink>()
    }
}
