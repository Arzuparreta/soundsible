package com.soundsible.android

import android.net.Uri
import androidx.media3.common.util.UnstableApi
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.ExtractorsFactory
import androidx.media3.extractor.mp4.FragmentedMp4Extractor

/** A growing spool cannot satisfy the default fMP4 extractor's initial tail-index seek yet. */
@UnstableApi
class PreviewExtractors : ExtractorsFactory {
    private val defaults = DefaultExtractorsFactory()
    override fun createExtractors(): Array<Extractor> = defaults.createExtractors()
    override fun createExtractors(uri: Uri, headers: Map<String, List<String>>): Array<Extractor> {
        val progressive = headers.entries.any { it.key.equals("X-Soundsible-Playback-Cache", true) && it.value.contains("progressive") }
        return defaults.createExtractors(uri, headers).map {
            if (progressive && it is FragmentedMp4Extractor) FragmentedMp4Extractor(FragmentedMp4Extractor.FLAG_DISABLE_HAGC_METADATA) else it
        }.toTypedArray()
    }
}
