package com.soundsible.android

import java.io.File
import java.io.IOException
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class OfflineFileRemovalTest {
    @Test fun removesAudioAndPartialAndAcceptsAlreadyMissingFiles() {
        val root = Files.createTempDirectory("offline-removal").toFile()
        try {
            val audio = File(root, "audio").apply { writeText("audio") }
            val partial = File(root, "partial").apply { writeText("partial") }
            OfflineFileRemoval.remove(audio, partial)
            assertFalse(audio.exists()); assertFalse(partial.exists())
            OfflineFileRemoval.remove(audio, partial)
        } finally { root.deleteRecursively() }
    }
    @Test fun refusesFalseSuccessAndStillCleansTheOtherFile() {
        val root = Files.createTempDirectory("offline-removal").toFile()
        try {
            val audio = File(root, "audio").apply { mkdir(); File(this, "held").writeText("held") }
            val partial = File(root, "partial").apply { writeText("partial") }
            try { OfflineFileRemoval.remove(audio, partial); fail("Expected storage failure") }
            catch (error: IOException) { assertEquals("storage", error.message) }
            assertTrue(audio.exists()); assertFalse(partial.exists())
            audio.deleteRecursively()
            OfflineFileRemoval.remove(audio, partial)
        } finally { root.deleteRecursively() }
    }
}
