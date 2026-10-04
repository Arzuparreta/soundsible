package com.soundsible.player.playback

import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.session.MediaController
import com.soundsible.player.data.CarItem
import com.soundsible.player.logic.PlayQueue

/**
 * Shared queue between Browse and Now Playing. The service reads the same
 * instance when it builds its Media3 queue, so phone UI and Auto stay on the
 * same track list.
 */
object QueueHolder {
    val queue = PlayQueue()
    private var controller: MediaController? = null
    var authHeader: String? = null
        private set

    /** Playback offset to apply on the next attach (restored sessions). */
    @Volatile var pendingSeekMs: Long = 0L

    @Synchronized
    fun replace(items: List<CarItem>, startIndex: Int) {
        queue.apply {
            // Rebuild by clearing through removals, then appending.
            while (!isEmpty) removeAt(0)
            append(contentsOf = items)
            jump(startIndex.coerceIn(0, (count - 1).coerceAtLeast(0)))
        }
        controller?.let { playOn(it) }
    }

    @Synchronized
    fun attach(controller: MediaController?) {
        this.controller = controller
        if (controller != null && queue.count > 0) {
            playOn(controller)
            val seek = pendingSeekMs
            if (seek > 0) {
                pendingSeekMs = 0L
                try {
                    controller.seekTo(seek)
                } catch (_: Exception) {
                }
            }
        }
    }

    fun setAuth(token: String?) {
        authHeader = token?.let { "Bearer $it" }
    }

    private fun playOn(controller: MediaController) {
        val items = queue.items.mapIndexed { index, item -> mediaItem(item, index) }
        if (items.isEmpty()) return
        val start = (queue.currentIndex ?: 0).coerceIn(0, items.size - 1)
        // setMediaItems is fire-and-forget through the session (which
        // resolves the stream URLs): prepare/play must wait for the first
        // non-empty timeline, otherwise they run against an empty player and
        // nothing ever sounds (and no notification posts).
        controller.addListener(object : Player.Listener {
            override fun onTimelineChanged(timeline: Timeline, reason: Int) {
                if (timeline.isEmpty) return
                try {
                    controller.removeListener(this)
                } catch (_: Exception) {
                }
                try {
                    controller.prepare()
                    controller.play()
                } catch (_: Exception) {
                }
            }
        })
        controller.setMediaItems(items, start, 0L)
    }

    fun mediaItem(item: CarItem, index: Int): MediaItem {
        val metadata = MediaMetadata.Builder()
            .setTitle(item.title)
            .setArtist(item.artist.ifEmpty { item.subtitle })
            .setAlbumTitle(item.album)
            .build()
        return MediaItem.Builder()
            .setMediaId(item.effectiveTrackId() ?: item.id)
            .setUri(item.streamUrl)
            .setMediaMetadata(metadata)
            .setTag(index)
            .build()
    }
}
