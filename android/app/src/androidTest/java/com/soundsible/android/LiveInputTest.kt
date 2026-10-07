package com.soundsible.android

import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.*
import org.junit.Test
import org.webrtc.*
import org.webrtc.audio.JavaAudioDeviceModule
import org.webrtc.audio.WebRtcAudioRecord
import java.nio.ByteOrder
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.*

/** Real Opus encode/decode between independent peers, without microphone access. */
class LiveInputTest {
    private open class Observer : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {}
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}
        override fun onIceCandidate(candidate: IceCandidate) {}
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
        override fun onAddStream(stream: MediaStream) {}
        override fun onRemoveStream(stream: MediaStream) {}
        override fun onDataChannel(channel: DataChannel) {}
        override fun onRenegotiationNeeded() {}
    }
    private fun description(action: (SdpObserver) -> Unit): SessionDescription {
        val result = CompletableFuture<SessionDescription>()
        action(object : SdpObserver {
            override fun onCreateSuccess(value: SessionDescription) { result.complete(value) }
            override fun onCreateFailure(error: String) { result.completeExceptionally(IllegalStateException(error)) }
            override fun onSetSuccess() {}
            override fun onSetFailure(error: String) { result.completeExceptionally(IllegalStateException(error)) }
        })
        return result.get(15, TimeUnit.SECONDS)
    }
    private fun set(action: (SdpObserver) -> Unit) {
        val result = CompletableFuture<Boolean>()
        action(object : SdpObserver {
            override fun onCreateSuccess(value: SessionDescription) {}
            override fun onCreateFailure(error: String) { result.completeExceptionally(IllegalStateException(error)) }
            override fun onSetSuccess() { result.complete(true) }
            override fun onSetFailure(error: String) { result.completeExceptionally(IllegalStateException(error)) }
        })
        result.get(15, TimeUnit.SECONDS)
    }
    private fun await(label: String, condition: () -> Boolean) {
        val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
        while (System.nanoTime() < until) { if (condition()) return; Thread.sleep(50) }
        fail(label)
    }
    @Test fun externalPcmEncodesAndDecodesWithoutMicrophone() = run(null)
    @Test fun httpNativeProgramme() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"))
    @Test fun tlsNativeProgramme() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"))
    @androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
    private fun run(origin: String?) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val connection = EngineConnection.shared(context)
        var scenario: androidx.test.core.app.ActivityScenario<MainActivity>? = null
        var browser: androidx.media3.session.MediaBrowser? = null
        fun <T> call(work: () -> com.google.common.util.concurrent.ListenableFuture<T>): T {
            val future = AtomicReference<com.google.common.util.concurrent.ListenableFuture<T>>()
            instrumentation.runOnMainSync { future.set(work()) }
            return future.get().get(15, TimeUnit.SECONDS)
        }
        if (origin != null) {
            connection.clearSession(true)
            val epoch = connection.configure(origin)
            connection.execute("/api/auth/login", "POST", "{\"username\":\"member\",\"password\":\"android-test\"}".toRequestBody("application/json".toMediaType()), emptyMap(), epoch, "live-input-login", 15000)
                .use { assertTrue(it.isSuccessful) }
            scenario = androidx.test.core.app.ActivityScenario.launch(MainActivity::class.java)
            browser = call { androidx.media3.session.MediaBrowser.Builder(context,
                androidx.media3.session.SessionToken(context, android.content.ComponentName(context, PlaybackService::class.java))).buildAsync() }
        }
        assertNotEquals(android.content.pm.PackageManager.PERMISSION_GRANTED, context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO))
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions())
        val mode = AtomicInteger(1)
        var frame = 0L
        val synthetic = WebRtcAudioRecord.ProgramInput { bytes, rate, channels ->
            for (offset in bytes.indices step channels * 2) {
                val sample = if (mode.get() == 1) (8192 * sin(2 * PI * 440 * frame / rate)).toInt() else 0
                for (channel in 0 until channels) { bytes[offset + channel * 2] = sample.toByte(); bytes[offset + channel * 2 + 1] = (sample shr 8).toByte() }
                frame++
            }
        }
        val programme = if (origin != null) LiveProgramInput(connection) else null
        val input: WebRtcAudioRecord.ProgramInput = programme ?: synthetic
        assertTrue(WebRtcAudioRecord.attach(input))
        val adm = JavaAudioDeviceModule.builder(context).setSampleRate(48000).setUseStereoInput(true).setUseStereoOutput(true)
            .setUseHardwareAcousticEchoCanceler(false).setUseHardwareNoiseSuppressor(false).setEnableVolumeLogger(false).createAudioDeviceModule()
        adm.setSpeakerMute(true)
        val factory = PeerConnectionFactory.builder().setAudioDeviceModule(adm).createPeerConnectionFactory()
        val received = AtomicReference<Double>(0.0)
        val remoteTrack = AtomicReference<AudioTrack>()
        val sink = AudioTrackSink { data, bits, rate, channels, frames, _ ->
            if (bits == 16 && rate == 48000 && channels >= 1 && frames > 0) {
                val view = data.asReadOnlyBuffer().order(ByteOrder.LITTLE_ENDIAN)
                var square = 0.0; var count = 0
                while (view.remaining() >= 2) { val value = view.short.toDouble(); square += value * value; count++ }
                if (count > 0) received.set(sqrt(square / count))
            }
        }
        val config = PeerConnection.RTCConfiguration(emptyList()).apply { sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN }
        val sender = factory.createPeerConnection(config, Observer())!!
        val receiver = factory.createPeerConnection(config, object : Observer() {
            override fun onTrack(transceiver: RtpTransceiver) {
                (transceiver.receiver.track() as? AudioTrack)?.let { remoteTrack.set(it); it.addSink(sink) }
            }
        })!!
        val constraints = MediaConstraints().apply {
            for (name in listOf("googEchoCancellation", "googAutoGainControl", "googNoiseSuppression", "googHighpassFilter")) mandatory.add(MediaConstraints.KeyValuePair(name, "false"))
        }
        val source = factory.createAudioSource(constraints)
        val track = factory.createAudioTrack("programme", source)
        try {
            sender.addTrack(track, listOf("programme"))
            val offer = description { sender.createOffer(it, MediaConstraints()) }
            set { sender.setLocalDescription(it, offer) }
            await("Sender ICE gathering", { sender.iceGatheringState() == PeerConnection.IceGatheringState.COMPLETE })
            set { receiver.setRemoteDescription(it, sender.localDescription) }
            val answer = description { receiver.createAnswer(it, MediaConstraints()) }
            set { receiver.setLocalDescription(it, answer) }
            await("Receiver ICE gathering", { receiver.iceGatheringState() == PeerConnection.IceGatheringState.COMPLETE })
            set { sender.setRemoteDescription(it, receiver.localDescription) }
            browser?.let { active ->
                val songs = call { active.getChildren("all-tracks", 0, 200, null) }.value!!
                val song = songs.single { it.mediaId == "soundsible:track:member-track" }
                instrumentation.runOnMainSync { active.setMediaItem(song); active.prepare(); active.play() }
            }
            await("Opus receiver did not decode programme PCM", { received.get() > 500 })
            browser?.let { active ->
                instrumentation.runOnMainSync { active.volume = 0f }
                Thread.sleep(500)
                await("Local mute silenced the broadcast", { received.get() > 500 })
                instrumentation.runOnMainSync { active.pause() }
            }
            mode.set(0); Thread.sleep(500)
            await("Pause did not encode digital silence", { received.get() < 20 })
            mode.set(1)
            browser?.let { active -> instrumentation.runOnMainSync { active.play() } }
            await("Programme resume did not recover receiver PCM", { received.get() > 500 })
            assertFalse(programme?.failed ?: false)
        } finally {
            remoteTrack.get()?.removeSink(sink)
            sender.close(); receiver.close(); sender.dispose(); receiver.dispose()
            track.dispose(); source.dispose(); factory.dispose(); adm.release(); WebRtcAudioRecord.detach(input)
            programme?.close()
            browser?.let { active -> instrumentation.runOnMainSync { active.release() } }
            scenario?.close()
            if (origin != null) connection.clearSession(true)
        }
    }
}
