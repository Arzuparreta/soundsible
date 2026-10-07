package com.soundsible.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat

/** One focus/noisy owner for a programme whose private decoders never request focus. */
internal class ProgramAudioFocus(context: Context, private val main: Handler,
    private val onFocus: (Int) -> Unit, private val onNoisy: () -> Unit) : AutoCloseable {
    private val context = context.applicationContext
    private val manager = this.context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var requested = false
    private var registered = false
    private var closed = false
    private var lease = 0L
    private val listener = AudioManager.OnAudioFocusChangeListener { change ->
        val token = lease
        main.post { if (!closed && requested && token == lease) onFocus(change) }
    }
    private val request: Any? = if (Build.VERSION.SDK_INT >= 26) Api26.create(listener, main) else null
    private val noisy = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (!closed && requested && intent.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) onNoisy()
        }
    }
    @Suppress("DEPRECATION")
    fun acquire(): Boolean {
        check(Looper.myLooper() == main.looper && !closed)
        requested = true
        val result = if (Build.VERSION.SDK_INT >= 26) Api26.acquire(manager, request!!)
            else manager.requestAudioFocus(listener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
        val granted = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        if (granted && !registered) {
            ContextCompat.registerReceiver(context, noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
                null, main, ContextCompat.RECEIVER_NOT_EXPORTED)
            registered = true
        }
        return granted
    }
    @Suppress("DEPRECATION")
    fun abandon() {
        check(Looper.myLooper() == main.looper)
        if (requested) {
            lease++
            requested = false
            if (Build.VERSION.SDK_INT >= 26) Api26.abandon(manager, request!!)
            else manager.abandonAudioFocus(listener)
        }
        if (registered) { context.unregisterReceiver(noisy); registered = false }
    }
    override fun close() { abandon(); closed = true }
    @androidx.annotation.RequiresApi(26)
    private object Api26 {
        fun create(listener: AudioManager.OnAudioFocusChangeListener, main: Handler): Any =
            AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
                .setOnAudioFocusChangeListener(listener, main).build()
        fun acquire(manager: AudioManager, request: Any) = manager.requestAudioFocus(request as AudioFocusRequest)
        fun abandon(manager: AudioManager, request: Any) { manager.abandonAudioFocusRequest(request as AudioFocusRequest) }
    }
}
