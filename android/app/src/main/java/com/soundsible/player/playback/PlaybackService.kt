package com.soundsible.player.playback

import android.app.PendingIntent
import android.content.Intent
import androidx.media3.common.AudioAttributes
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.soundsible.player.R
import com.soundsible.player.SoundsibleApp
import com.soundsible.player.data.CarItem
import com.soundsible.player.data.DeviceRegistration
import com.soundsible.player.data.RemotePlaybackState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

private const val ROOT_ID = "soundsible-root"

/**
 * Foreground playback plus the browse tree Android Auto renders from.
 *
 * Root collections match the engine contract (`recently-played`, `favourites`,
 * `playlists`, `podcasts`, `radio`, `all-tracks`); children resolve through
 * `/api/car/items/<id>`. Authenticated streams carry the paired-device Bearer
 * token via the HTTP data source, the same header the iOS resource-loader
 * delegate attaches to its byte-range requests.
 *
 * v1 scope: phone playback + Auto browse/play. Offline downloads live in
 * [OfflineStore] and are not yet exposed as a library branch.
 */
class PlaybackService : MediaLibraryService() {
    private var session: MediaLibrarySession? = null
    private var player: ExoPlayer? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private fun app(): SoundsibleApp = application as SoundsibleApp

    override fun onCreate() {
        super.onCreate()
        setMediaNotificationProvider(
            androidx.media3.session.DefaultMediaNotificationProvider(this).apply {
                setSmallIcon(R.mipmap.ic_launcher)
            },
        )
        // The Bearer token is read fresh for every connection, so re-pairing
        // mid-session applies to the next stream without rebuilding the player
        // -- the same header the iOS resource-loader delegate attaches to its
        // byte-range requests.
        val authFactory = DataSource.Factory {
            DefaultHttpDataSource.Factory()
                .setUserAgent("Soundsible-Android/1.0")
                .apply {
                    val token = app().tokenStore.load()?.token
                    if (token != null) setDefaultRequestProperties(mapOf("Authorization" to "Bearer $token"))
                }
                .createDataSource()
        }
        val player = ExoPlayer.Builder(this)
            .setAudioAttributes(AudioAttributes.DEFAULT, true)
            .setHandleAudioBecomingNoisy(true)
            .setMediaSourceFactory(DefaultMediaSourceFactory(authFactory))
            .build()
            .also { this.player = player }
        player.addListener(stateListener)
        val sessionActivity = PendingIntent.getActivity(
            this,
            0,
            Intent(this, com.soundsible.player.ui.NowPlayingActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        session = MediaLibrarySession.Builder(this, player, libraryCallback)
            .setSessionActivity(sessionActivity)
            .build()
        scope.launch {
            try {
                val identity = app().deviceIdentity
                app().client.registerDevice(
                    DeviceRegistration(identity.deviceId, identity.deviceName),
                )
            } catch (_: Exception) {
                // Presence is best-effort; playback must not depend on it.
            }
        }
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

    override fun onDestroy() {
        scope.cancel()
        session?.release()
        player?.release()
        session = null
        player = null
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Keep sounding when the UI is swiped away; stop only on pause.
        val p = player
        if (p != null && !p.playWhenReady) stopSelf()
    }

    private val stateListener = object : Player.Listener {
        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            publishState()
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            publishState()
        }
    }

    private fun publishState() {
        val p = player ?: return
        val item = p.currentMediaItem
        scope.launch {
            try {
                app().client.publishPlaybackState(
                    RemotePlaybackState(
                        trackId = item?.mediaId,
                        positionSec = (p.currentPosition / 1000.0).coerceAtLeast(0.0),
                        isPlaying = p.isPlaying,
                        deviceId = app().deviceIdentity.deviceId,
                    ),
                )
            } catch (_: Exception) {
                // State publishing is best-effort.
            }
        }
    }

    private val libraryCallback = object : MediaLibrarySession.Callback {
        override fun onGetLibraryRoot(
            session: MediaLibrarySession,
            browser: MediaSession.ControllerInfo,
            params: LibraryParams?,
        ): ListenableFuture<LibraryResult<MediaItem>> {
            val root = MediaItem.Builder()
                .setMediaId(ROOT_ID)
                .setMediaMetadata(
                    androidx.media3.common.MediaMetadata.Builder()
                        .setTitle("Soundsible")
                        .setIsBrowsable(true)
                        .setIsPlayable(false)
                        .build(),
                )
                .build()
            return Futures.immediateFuture(LibraryResult.ofItem(root, params))
        }

        override fun onGetChildren(
            session: MediaLibrarySession,
            browser: MediaSession.ControllerInfo,
            parentId: String,
            pageIndex: Int,
            pageSize: Int,
            params: LibraryParams?,
        ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
            if (parentId == ROOT_ID) {
                return Futures.immediateFuture(
                    LibraryResult.ofItemList(rootCollections(), params),
                )
            }
            val future = com.google.common.util.concurrent.SettableFuture.create<LibraryResult<ImmutableList<MediaItem>>>()
            scope.launch {
                try {
                    val items = app().client.items(parentId).items
                    future.set(LibraryResult.ofItemList(toMediaItems(items), params))
                } catch (e: Exception) {
                    future.setException(e)
                }
            }
            return future
        }

        override fun onGetItem(
            session: MediaLibrarySession,
            browser: MediaSession.ControllerInfo,
            mediaId: String,
        ): ListenableFuture<LibraryResult<MediaItem>> {
            val future = com.google.common.util.concurrent.SettableFuture.create<LibraryResult<MediaItem>>()
            scope.launch {
                try {
                    // mediaId is a track id; resolve a playable item via search of
                    // the queue first, then fall back to a direct stream URL.
                    val queued = QueueHolder.queue.items.firstOrNull { it.effectiveTrackId() == mediaId }
                    val item = if (queued != null) {
                        QueueHolder.mediaItem(queued, 0)
                    } else {
                        val connection = app().tokenStore.load()
                        val stream = connection?.resolve("/api/static/stream/$mediaId")
                        MediaItem.Builder().setMediaId(mediaId).setUri(stream).build()
                    }
                    future.set(LibraryResult.ofItem(item, null))
                } catch (e: Exception) {
                    future.setException(e)
                }
            }
            return future
        }

        override fun onAddMediaItems(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
            mediaItems: MutableList<MediaItem>,
        ): ListenableFuture<MutableList<MediaItem>> {
            // Resolve relative stream paths against the paired server before
            // playback. Auth headers ride on the data source (see onCreate).
            val connection = app().tokenStore.load()
            val resolved = mediaItems.map { item ->
                val raw = item.localConfiguration?.uri?.toString() ?: item.mediaId
                val uri = if (raw.startsWith("http")) raw else connection?.resolve(raw)
                item.buildUpon().setUri(uri).build()
            }.toMutableList()
            return Futures.immediateFuture(resolved)
        }
    }

    private fun rootCollections(): ImmutableList<MediaItem> {
        val defs = listOf(
            "recently-played" to "Recently played",
            "favourites" to "Favourites",
            "playlists" to "Playlists",
            "podcasts" to "Podcasts",
            "radio" to "Radio",
            "all-tracks" to "All tracks",
        )
        val builder = ImmutableList.builder<MediaItem>()
        for ((id, title) in defs) {
            builder.add(
                MediaItem.Builder()
                    .setMediaId(id)
                    .setMediaMetadata(
                        androidx.media3.common.MediaMetadata.Builder()
                            .setTitle(title)
                            .setIsBrowsable(true)
                            .setIsPlayable(false)
                            .setMediaType(androidx.media3.common.MediaMetadata.MEDIA_TYPE_MIXED)
                            .build(),
                    )
                    .build(),
            )
        }
        return builder.build()
    }

    private fun toMediaItems(items: List<CarItem>): ImmutableList<MediaItem> {
        val connection = app().tokenStore.load()
        val builder = ImmutableList.builder<MediaItem>()
        for (item in items) {
            val metadata = androidx.media3.common.MediaMetadata.Builder()
                .setTitle(item.title)
                .setArtist(item.artist.ifEmpty { item.subtitle.ifEmpty { null } })
                .setAlbumTitle(item.album.ifEmpty { null })
                .setIsBrowsable(item.isBrowsable)
                .setIsPlayable(item.isPlayable)
                .setMediaType(
                    when {
                        item.isBrowsable -> androidx.media3.common.MediaMetadata.MEDIA_TYPE_MIXED
                        else -> androidx.media3.common.MediaMetadata.MEDIA_TYPE_MUSIC
                    },
                )
                .build()
            val uri = item.streamUrl?.let { connection?.resolve(it) ?: it }
            builder.add(
                MediaItem.Builder()
                    .setMediaId(item.id)
                    .setUri(uri)
                    .setMediaMetadata(metadata)
                    .build(),
            )
        }
        return builder.build()
    }
}
