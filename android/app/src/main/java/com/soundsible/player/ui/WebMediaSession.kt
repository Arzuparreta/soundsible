package com.soundsible.player.ui

import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.webkit.WebView
import java.lang.ref.WeakReference

/**
 * The Android media session for page (WebView) playback: publishes playback
 * state, metadata and artwork to the system, and routes transport controls
 * back into the page. This is what launchers, Bluetooth, the lock screen
 * and car head units read -- Media3 never sees page audio, so without this
 * the phone sounds with no session active anywhere.
 *
 * Lifetime follows the page: create with the activity, release with it.
 */
class WebMediaSession(
    private val activity: LibraryActivity,
    webView: WebView,
) {
    private val viewRef = WeakReference(webView)
    private val main = Handler(Looper.getMainLooper())
    private val session = MediaSessionCompat(activity, TAG).apply {
        setFlags(
            MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS or
                MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS,
        )
        setCallback(object : MediaSessionCompat.Callback() {
            override fun onPlay() = js("play()")
            override fun onPause() = js("pause()")
            override fun onSkipToNext() = js("next()")
            override fun onSkipToPrevious() = js("previous()")
            override fun onStop() = js("pause()")
        }, main)
        isActive = false
    }

    /** Compat token for linking media-template notifications to this session. */
    val token get() = session.sessionToken

    /** Publish the sounding track (or clear with an empty title). */
    fun publish(title: String, artist: String, album: String, isPlaying: Boolean, artwork: Bitmap?) {
        if (title.isEmpty()) {
            session.isActive = false
            try {
                session.setPlaybackState(
                    PlaybackStateCompat.Builder()
                        .setState(PlaybackStateCompat.STATE_STOPPED, 0L, 0f)
                        .build(),
                )
            } catch (_: Exception) {
            }
            return
        }
        try {
            val metadata = MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
                .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, album)
                .apply {
                    if (artwork != null) putBitmap(MediaMetadataCompat.METADATA_KEY_ART, artwork)
                }
                .build()
            session.setMetadata(metadata)
            val state = if (isPlaying) {
                PlaybackStateCompat.STATE_PLAYING
            } else {
                PlaybackStateCompat.STATE_PAUSED
            }
            session.setPlaybackState(
                PlaybackStateCompat.Builder()
                    .setActions(
                        PlaybackStateCompat.ACTION_PLAY or
                            PlaybackStateCompat.ACTION_PAUSE or
                            PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                            PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
                            PlaybackStateCompat.ACTION_STOP,
                    )
                    .setState(state, PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1f)
                    .build(),
            )
            session.isActive = true
        } catch (_: Exception) {
        }
    }

    fun release() {
        try {
            session.isActive = false
            session.release()
        } catch (_: Exception) {
        }
    }

    private fun js(call: String) {
        val view = viewRef.get() ?: return
        main.post {
            try {
                view.evaluateJavascript(
                    "(function(){var c=window.SoundsibleNativeControl;if(c&&c.$call){c.$call();}})()",
                    null,
                )
            } catch (_: Exception) {
            }
        }
    }

    companion object {
        private const val TAG = "SoundsibleWeb"
    }
}
