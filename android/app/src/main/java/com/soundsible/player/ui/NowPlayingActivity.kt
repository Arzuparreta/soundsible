package com.soundsible.player.ui

import android.app.Activity
import android.content.ComponentName
import android.os.Bundle
import android.widget.TextView
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.media3.ui.PlayerView
import com.google.common.util.concurrent.MoreExecutors
import com.soundsible.player.R
import com.soundsible.player.playback.PlaybackService
import com.soundsible.player.playback.QueueHolder

/**
 * Now Playing screen bound to [PlaybackService] through a MediaController.
 * Queue state lives in [QueueHolder], shared with BrowseActivity.
 */
class NowPlayingActivity : Activity() {
    private var controller: MediaController? = null
    private lateinit var playerView: PlayerView
    private lateinit var titleView: TextView
    private lateinit var subtitleView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_now_playing)
        playerView = findViewById(R.id.playerView)
        titleView = findViewById(R.id.trackTitle)
        subtitleView = findViewById(R.id.trackSubtitle)
        refreshLabels()
    }

    override fun onStart() {
        super.onStart()
        val token = SessionToken(this, ComponentName(this, PlaybackService::class.java))
        val future = MediaController.Builder(this, token).buildAsync()
        future.addListener(
            {
                controller = future.get()
                playerView.player = controller
                QueueHolder.attach(controller)
            },
            MoreExecutors.directExecutor(),
        )
    }

    override fun onStop() {
        playerView.player = null
        controller?.release()
        controller = null
        super.onStop()
    }

    private fun refreshLabels() {
        val current = QueueHolder.queue.current
        titleView.text = current?.title ?: getString(R.string.now_playing)
        subtitleView.text = current?.subtitle?.ifEmpty { current.artist } ?: ""
    }
}
