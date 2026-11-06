package com.soundsible.android

import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.UnstableApi
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@UnstableApi
@RunWith(AndroidJUnit4::class)
class CollectionIdentityTest {
    @Test fun deviceSnapshotKeepsMusicalSourceAndOccurrenceIdentitiesSeparate() {
        val item = MediaItem.Builder().setMediaId("7N3rFdE3u3Y")
            .setMediaMetadata(MediaMetadata.Builder().setTitle("Autorretrato").setExtras(Bundle().apply {
                putString(ProgramQueue.ITEM, "stable-musical-item")
                putString(ProgramQueue.KEY, "this-occurrence")
                putString(ProgramQueue.SOURCE, "preview")
            }).build()).build()
        val snapshot = ProgramDeviceState.track(item)
        assertEquals("stable-musical-item", snapshot.getString("item_id"))
        assertEquals("7N3rFdE3u3Y", snapshot.getString("id"))
        assertEquals("this-occurrence", item.mediaMetadata.extras!!.getString(ProgramQueue.KEY))
    }
}
