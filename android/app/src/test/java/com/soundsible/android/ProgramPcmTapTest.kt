package com.soundsible.android

import org.junit.Assert.*
import org.junit.Test
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

class ProgramPcmTapTest {
    private val stream = ProgramPcmTap.Stream(7, "occurrence", "programme", "local", 0)
    @Test fun blockedConsumerCannotGrowTheQueueOrBlockPlaybackOffers() {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        ProgramPcmTap().use { tap ->
            val capture = tap.subscribe({ true }) { entered.countDown(); release.await(5, TimeUnit.SECONDS) }
            val source = ByteBuffer.wrap(ByteArray(65536))
            tap.offer(source, 48000, 2, stream, 0); assertTrue(entered.await(2, TimeUnit.SECONDS))
            val started = System.nanoTime(); repeat(100) { tap.offer(source, 48000, 2, stream, it.toLong()) }
            assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started) < 1000)
            assertEquals(92, capture.dropped.get()); assertEquals(0, source.position()); release.countDown()
        }
    }
    @Test fun accountChangeDiscardsBufferedPrivateAudioAndLiveInputIsNeverRecaptured() {
        val generation = AtomicLong(7); val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val received = AtomicLong()
        ProgramPcmTap().use { tap ->
            tap.subscribe({ it.generation == generation.get() }) { received.incrementAndGet(); entered.countDown(); release.await(5, TimeUnit.SECONDS) }
            val source = ByteBuffer.wrap(ByteArray(16))
            tap.offer(source, 48000, 2, stream, 0); assertTrue(entered.await(2, TimeUnit.SECONDS))
            repeat(8) { tap.offer(source, 48000, 2, stream, 0) }; generation.set(8); release.countDown()
            tap.offer(source, 48000, 2, stream.copy(generation = 8, source = "live"), 0)
            Thread.sleep(150); assertEquals(1, received.get())
        }
    }
    @Test fun deliveryOwnsACopyAndConsumerFailureCannotThrowIntoPlayback() {
        val done = CountDownLatch(1)
        ProgramPcmTap().use { tap ->
            val capture = tap.subscribe({ true }) { assertEquals(4, it.bytes.size); done.countDown(); throw IllegalStateException("consumer stopped") }
            val source = ByteBuffer.wrap(byteArrayOf(1, 2, 3, 4)); tap.offer(source, 16000, 1, stream, 0)
            assertEquals(0, source.position()); assertTrue(done.await(2, TimeUnit.SECONDS))
            val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
            while (!capture.failed.get() && System.nanoTime() < until) Thread.yield()
            assertTrue(capture.failed.get()); tap.offer(source, 16000, 1, stream, 0)
        }
    }
}
