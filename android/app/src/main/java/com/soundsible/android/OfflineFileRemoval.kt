package com.soundsible.android

import java.io.File
import java.io.IOException

/** Missing files are already retired; failed removal must remain recoverable in the store. */
object OfflineFileRemoval {
    fun retainedBytes(audio: File, partial: File): Long = listOf(audio, partial).sumOf { if (it.isFile) it.length() else 0L }
    fun remove(audio: File, partial: File) {
        var failed = false
        for (file in listOf(audio, partial)) {
            if (!file.delete() && file.exists()) failed = true
        }
        if (failed) throw IOException("storage")
    }
}
