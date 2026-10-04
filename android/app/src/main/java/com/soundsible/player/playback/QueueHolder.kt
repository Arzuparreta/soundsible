package com.soundsible.player.playback

import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
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
        if (controller != null && queue.count > 0) playOn(controller)
    }

    fun setAuth(token: String?) {
        authHeader = token?.let { "Bearer $it" }
    }

    private fun playOn(controller: MediaController) {
        val items = queue.items.mapIndexed { index, item -> mediaItem(item, index) }
        if (items.isEmpty()) return
        val start = (queue.currentIndex ?: 0).coerceIn(0, items.size - 1)
        controller.setMediaItems(items, start, 0L)
        controller.prepare()
        controller.play()
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
