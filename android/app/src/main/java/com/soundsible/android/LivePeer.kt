package com.soundsible.android

import android.content.Context
import androidx.media3.common.util.UnstableApi
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.webrtc.*
import org.webrtc.audio.JavaAudioDeviceModule
import org.webrtc.audio.WebRtcAudioRecord
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Native WHIP/WHEP resource. Call start/close on a worker, never the UI/player looper. */
@UnstableApi
internal class LivePeer(
    private val context: Context,
    private val connection: EngineConnection,
    private val endpoint: String,
    private val token: String?,
    private val publishing: Boolean,
    private val onState: (PeerConnection.PeerConnectionState) -> Unit,
    private val onAudio: AudioTrackSink? = null,
) : AutoCloseable {
    private val epoch = connection.generation
    private val closed = AtomicBoolean()
    private var input: LiveProgramInput? = null
    private var adm: JavaAudioDeviceModule? = null
    private var factory: PeerConnectionFactory? = null
    private var peer: PeerConnection? = null
    private var source: AudioSource? = null
    private var outgoing: AudioTrack? = null
    private var incoming: AudioTrack? = null
    private var resource: HttpUrl? = null
    private val selected = endpoint.toHttpUrl().also { require(it.isHttps && it.username.isEmpty() && it.password.isEmpty()) }
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .callTimeout(20, TimeUnit.SECONDS).addInterceptor { chain ->
            val url = chain.request().url
            if (url.scheme != selected.scheme || url.host != selected.host || url.port != selected.port) throw java.io.IOException("LIVE_ORIGIN_ONLY")
            // This transport has no cookie jar, Core authentication or redirects.
            chain.proceed(chain.request())
        }.build()
    private fun owns() = !closed.get() && epoch == connection.generation
    private fun request(url: HttpUrl, method: String, sdp: String? = null): okhttp3.Response {
        val builder = Request.Builder().url(url).method(method, sdp?.toRequestBody("application/sdp".toMediaType()))
        token?.let { builder.header("Authorization", "Bearer $it") }
        return client.newCall(builder.build()).execute()
    }
    fun start() {
        check(owns())
        try {
            val ice = request(selected, "OPTIONS").use { response ->
                check(response.isSuccessful) { "LIVE_OPTIONS_${response.code}" }
                iceServers(response.headers.values("Link").joinToString(","))
            }
            check(owns())
            initialize(context)
            val module = JavaAudioDeviceModule.builder(context).setSampleRate(48000).setUseStereoInput(true).setUseStereoOutput(true)
                .setUseHardwareAcousticEchoCanceler(false).setUseHardwareNoiseSuppressor(false).setEnableVolumeLogger(false)
                .setAudioAttributes(android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_MUSIC).build()).createAudioDeviceModule()
            adm = module
            // Receiver playback is routed by its owner; tests receive decoded PCM without a second device output.
            module.setSpeakerMute(onAudio != null || publishing)
            if (publishing) {
                check(publisher.compareAndSet(null, this)) { "LIVE_INPUT_IN_USE" }
                input = LiveProgramInput(connection)
                check(WebRtcAudioRecord.attach(input!!)) { "LIVE_INPUT_IN_USE" }
            }
            val owner = PeerConnectionFactory.builder().setAudioDeviceModule(module).createPeerConnectionFactory()
            factory = owner
            val gathered = CountDownLatch(1)
            val config = PeerConnection.RTCConfiguration(ice).apply { sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN }
            val next = owner.createPeerConnection(config, object : PeerConnection.Observer {
                override fun onSignalingChange(state: PeerConnection.SignalingState) {}
                override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {}
                override fun onIceConnectionReceivingChange(receiving: Boolean) {}
                override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) { if (state == PeerConnection.IceGatheringState.COMPLETE) gathered.countDown() }
                override fun onIceCandidate(candidate: IceCandidate) {}
                override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
                override fun onAddStream(stream: MediaStream) {}
                override fun onRemoveStream(stream: MediaStream) {}
                override fun onDataChannel(channel: DataChannel) {}
                override fun onRenegotiationNeeded() {}
                override fun onConnectionChange(state: PeerConnection.PeerConnectionState) { if (owns()) onState(state) }
                override fun onTrack(transceiver: RtpTransceiver) {
                    (transceiver.receiver.track() as? AudioTrack)?.let { track -> incoming = track; onAudio?.let(track::addSink) }
                }
            }) ?: error("LIVE_PEER_FAILED")
            peer = next
            if (publishing) {
                source = owner.createAudioSource(MediaConstraints().apply {
                    for (name in listOf("googEchoCancellation", "googAutoGainControl", "googNoiseSuppression", "googHighpassFilter")) mandatory.add(MediaConstraints.KeyValuePair(name, "false"))
                })
                outgoing = owner.createAudioTrack("programme", source!!)
                val sender = next.addTrack(outgoing, listOf("programme"))
                val params = sender.parameters
                params.encodings.forEach { it.maxBitrateBps = 192000 }
                sender.parameters = params
            } else {
                next.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO,
                    RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.RECV_ONLY))
            }
            val offer = description { next.createOffer(it, MediaConstraints()) }
            val music = SessionDescription(offer.type, musicSdp(offer.description))
            set { next.setLocalDescription(it, music) }
            // Native gathering completes before POST, so no incomplete offer starts the relay deadline.
            check(gathered.await(15, TimeUnit.SECONDS)) { "LIVE_ICE_TIMEOUT" }
            check(owns())
            val answer = request(selected, "POST", next.localDescription.description).use { response ->
                check(response.code == 201) { "LIVE_OFFER_${response.code}" }
                resource = location(selected, response.header("Location") ?: error("LIVE_RESOURCE_MISSING"))
                val bytes = response.peekBody(262145).bytes()
                require(bytes.size <= 262144) { "LIVE_ANSWER_TOO_LARGE" }
                String(bytes, Charsets.UTF_8)
            }
            check(owns())
            set { next.setRemoteDescription(it, SessionDescription(SessionDescription.Type.ANSWER, answer)) }
        } catch (failure: Exception) { close(); throw failure }
    }
    fun setVolume(volume: Double) { require(volume in 0.0..1.0); incoming?.setVolume(volume) }
    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        incoming?.let { track -> onAudio?.let(track::removeSink) }
        peer?.close(); peer?.dispose(); peer = null
        outgoing?.dispose(); source?.dispose(); outgoing = null; source = null
        factory?.dispose(); factory = null; adm?.release(); adm = null
        input?.close(); input = null
        publisher.compareAndSet(this, null)
        resource?.let { url -> runCatching { request(url, "DELETE").close() } }; resource = null
        client.dispatcher.cancelAll(); client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown()
    }
    companion object {
        private val publisher = AtomicReference<LivePeer>()
        private var initialized = false
        @Synchronized private fun initialize(context: Context) {
            if (!initialized) { PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context.applicationContext).createInitializationOptions()); initialized = true }
        }
        internal fun location(endpoint: HttpUrl, value: String): HttpUrl {
            val target = endpoint.resolve(if (value.startsWith('/') && endpoint.encodedPath.startsWith("/media/")) "/media$value" else value) ?: error("LIVE_RESOURCE_INVALID")
            require(target.scheme == endpoint.scheme && target.host == endpoint.host && target.port == endpoint.port && target.username.isEmpty() && target.password.isEmpty()) { "LIVE_RESOURCE_ORIGIN" }
            return target
        }
        internal fun iceServers(header: String): List<PeerConnection.IceServer> = header.split(Regex(",(?=\\s*<)"))
            .mapNotNull { entry ->
                val address = Regex("^\\s*<([^>]+)>").find(entry)?.groupValues?.get(1) ?: return@mapNotNull null
                if (!Regex("^(stun|stuns|turn|turns):", RegexOption.IGNORE_CASE).containsMatchIn(address)) return@mapNotNull null
                val params = Regex(";\\s*([\\w-]+)\\s*=\\s*(?:\"((?:\\\\.|[^\"])*)\"|([^;,\\s]+))").findAll(entry)
                    .associate { it.groupValues[1].lowercase() to (it.groupValues[2].ifEmpty { it.groupValues[3] }.replace("\\\"", "\"").replace("\\\\", "\\")) }
                if ("ice-server" !in (params["rel"] ?: "").split(Regex("\\s+"))) return@mapNotNull null
                PeerConnection.IceServer.builder(address).apply {
                    if (params["username"] != null && params["credential"] != null) { setUsername(params["username"]); setPassword(params["credential"]) }
                }.createIceServer()
            }.take(16)
        internal fun musicSdp(sdp: String): String {
            val payload = Regex("(?m)^a=rtpmap:(\\d+) opus/48000/2\\r?$").find(sdp)?.groupValues?.get(1) ?: return sdp
            val pattern = Regex("(?m)^a=fmtp:$payload (.*?)(\\r?)$")
            val options = "stereo=1;sprop-stereo=1;usedtx=0;useinbandfec=1;maxaveragebitrate=192000"
            return if (pattern.containsMatchIn(sdp)) pattern.replace(sdp) { "a=fmtp:$payload ${it.groupValues[1]};$options${it.groupValues[2]}" }
                else sdp.replace("a=rtpmap:$payload opus/48000/2", "a=rtpmap:$payload opus/48000/2\r\na=fmtp:$payload $options")
        }
        private fun description(action: (SdpObserver) -> Unit): SessionDescription {
            val result = CompletableFuture<SessionDescription>()
            action(object : SdpObserver {
                override fun onCreateSuccess(value: SessionDescription) { result.complete(value) }
                override fun onCreateFailure(error: String) { result.completeExceptionally(IllegalStateException(error)) }
                override fun onSetSuccess() {}
                override fun onSetFailure(error: String) { result.completeExceptionally(IllegalStateException(error)) }
            })
            return result.get(20, TimeUnit.SECONDS)
        }
        private fun set(action: (SdpObserver) -> Unit) {
            val result = CompletableFuture<Boolean>()
            action(object : SdpObserver {
                override fun onCreateSuccess(value: SessionDescription) {}
                override fun onCreateFailure(error: String) { result.completeExceptionally(IllegalStateException(error)) }
                override fun onSetSuccess() { result.complete(true) }
                override fun onSetFailure(error: String) { result.completeExceptionally(IllegalStateException(error)) }
            })
            result.get(20, TimeUnit.SECONDS)
        }
    }
}
