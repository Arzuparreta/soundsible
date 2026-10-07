package com.soundsible.android

import org.junit.Assert.*
import org.junit.Test
import okio.Buffer
import okio.blackholeSink
import okio.buffer
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.io.IOException

class ImportStreamBodyTest {
    @Test fun streamsAndClosesWithoutWholeFileBufferOrReplay() {
        val bytes = ByteArray(160000) { (it % 251).toByte() }
        var closed = false
        var largestRead = 0
        val input = object : ByteArrayInputStream(bytes) {
            override fun read(buffer: ByteArray, offset: Int, count: Int): Int { largestRead = maxOf(largestRead, count); return super.read(buffer, offset, count) }
            override fun close() { closed = true; super.close() }
        }
        val body = ImportStreamBody({ input }, { true }, bytes.size.toLong(), null)
        val sink = Buffer(); body.writeTo(sink)
        assertArrayEquals(bytes, sink.readByteArray()); assertTrue(closed)
        assertTrue(largestRead <= 65536); assertTrue(body.isOneShot())
    }
    @Test fun boundsUnknownSizeAndClosesOversizedProvider() {
        var remaining = ImportStreamBody.MAX_BYTES + 1; var closed = false
        val input = object : InputStream() {
            override fun read(): Int = error("Bulk reads required")
            override fun read(buffer: ByteArray, offset: Int, count: Int): Int {
                if (remaining == 0L) return -1
                val size = minOf(count.toLong(), remaining).toInt(); remaining -= size; return size
            }
            override fun close() { closed = true }
        }
        val sink = blackholeSink().buffer()
        try { ImportStreamBody({ input }, { true }, -1, null).writeTo(sink); fail("Oversized source accepted") }
        catch (expected: IOException) { assertEquals("IMPORT_TOO_LARGE", expected.message) }
        finally { sink.close() }
        assertTrue(closed)
    }
    @Test fun accountChangeAfterReadWritesNoStaleBytes() {
        var current = true; var closed = false
        val input = object : ByteArrayInputStream(byteArrayOf(1, 2, 3)) {
            override fun read(buffer: ByteArray, offset: Int, count: Int): Int { val read = super.read(buffer, offset, count); current = false; return read }
            override fun close() { closed = true; super.close() }
        }
        val sink = Buffer()
        try { ImportStreamBody({ input }, { current }, 3, null).writeTo(sink); fail("Stale bytes written") }
        catch (expected: IOException) { assertEquals("IMPORT_CANCELLED", expected.message) }
        assertEquals(0L, sink.size); assertTrue(closed)
    }
    @Test fun rejectsFalseDeclaredSizeAndClosesSource() {
        var closed = false
        val input = object : ByteArrayInputStream(byteArrayOf(1)) { override fun close() { closed = true; super.close() } }
        try { ImportStreamBody({ input }, { true }, 2, null).writeTo(Buffer()); fail("Changed source size accepted") }
        catch (expected: IOException) { assertEquals("IMPORT_SIZE_CHANGED", expected.message) }
        assertTrue(closed)
    }
    @Test fun rejectsDeclaredOversizeBeforeOpeningProvider() {
        var opened = false
        try { ImportStreamBody({ opened = true; ByteArrayInputStream(byteArrayOf()) }, { true }, ImportStreamBody.MAX_BYTES + 1, null); fail("Declared oversize accepted") }
        catch (_: IllegalArgumentException) {}
        assertFalse(opened)
    }
}
