package com.soundsible.player.logic

import com.soundsible.player.data.CarItem

data class OfflineTrack(
    val trackId: String,
    val filename: String,
    val byteSize: Long,
    val downloadedAt: Long = System.currentTimeMillis(),
    var lastPlayedAt: Long? = null,
    val pinnedBy: MutableSet<String> = mutableSetOf(),
)

/**
 * What is on the phone, what should be, and what has to go.
 *
 * Pure bookkeeping -- it never touches the filesystem. The app layer performs
 * the downloads and deletions this decides on, which is what makes the policy
 * unit-testable. Mirrors `OfflineLibrary` in ios/SoundsibleKit.
 */
class OfflineLibrary(
    tracks: List<OfflineTrack> = emptyList(),
    var byteBudget: Long? = null,
) {
    private val store: MutableMap<String, OfflineTrack> =
        tracks.associateBy { it.trackId }.toMutableMap()

    val usedBytes: Long get() = store.values.sumOf { it.byteSize }

    fun isAvailableOffline(trackId: String): Boolean = store.containsKey(trackId)

    fun filenameFor(trackId: String): String? = store[trackId]?.filename

    /**
     * Which of [items] still need fetching for this collection. Already-held
     * tracks are pinned in place rather than re-downloaded, so pinning a
     * playlist that overlaps another costs only the difference.
     */
    fun pin(collectionId: String, items: List<CarItem>): List<CarItem> {
        val missing = mutableListOf<CarItem>()
        for (item in items) {
            if (!item.isPlayable) continue
            val trackId = item.trackId ?: if (item.kind == "track") item.id else null
            ?: continue
            val held = store[trackId]
            if (held != null) {
                held.pinnedBy.add(collectionId)
            } else {
                missing.add(item)
            }
        }
        return missing
    }

    /** Record a finished download. */
    fun store(trackId: String, filename: String, byteSize: Long, collectionId: String) {
        val held = store[trackId]
        if (held != null) {
            held.pinnedBy.add(collectionId)
            return
        }
        store[trackId] = OfflineTrack(
            trackId = trackId,
            filename = filename,
            byteSize = byteSize,
            pinnedBy = mutableSetOf(collectionId),
        )
    }

    /** Release a collection and report the tracks nothing wants any more. */
    fun unpin(collectionId: String): List<OfflineTrack> {
        val orphaned = mutableListOf<OfflineTrack>()
        val ids = store.keys.toList()
        for (id in ids) {
            val track = store[id] ?: continue
            if (!track.pinnedBy.contains(collectionId)) continue
            track.pinnedBy.remove(collectionId)
            if (track.pinnedBy.isEmpty()) {
                orphaned.add(track)
                store.remove(id)
            }
        }
        return orphaned
    }

    fun markPlayed(trackId: String, at: Long = System.currentTimeMillis()) {
        store[trackId]?.lastPlayedAt = at
    }

    /**
     * Evict until the library fits its budget, and report what to delete.
     * Least-recently-touched first; pinned tracks are never evicted.
     */
    fun evictToFitBudget(now: Long = System.currentTimeMillis()): List<OfflineTrack> {
        val budget = byteBudget ?: return emptyList()
        if (usedBytes <= budget) return emptyList()
        val evictable = store.values
            .filter { it.pinnedBy.isEmpty() }
            .sortedBy { it.lastPlayedAt ?: it.downloadedAt }
        val evicted = mutableListOf<OfflineTrack>()
        var used = usedBytes
        for (candidate in evictable) {
            if (used <= budget) break
            store.remove(candidate.trackId)
            used -= candidate.byteSize
            evicted.add(candidate)
        }
        return evicted
    }
}
