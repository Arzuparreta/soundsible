package com.soundsible.android

import java.nio.ByteBuffer
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/** Optional native consumer after DSP, before local output volume; no microphone or JS reads. */
internal class ProgramPcmTap : AutoCloseable {
    data class Stream(val generation: Long, val key: String, val program: String, val source: String, val positionOffsetUs: Long)
    data class Block(val bytes: ByteArray, val sampleRate: Int, val channels: Int, val stream: Stream, val frameOffset: Long)
    private val active = AtomicReference<Capture?>()
    fun subscribe(owns: (Stream) -> Boolean, consume: (Block) -> Unit): Capture {
        val capture = Capture(owns, consume)
        active.getAndSet(capture)?.close()
        return capture
    }
    fun offer(bytes: ByteBuffer, sampleRate: Int, channels: Int, stream: Stream, frameOffset: Long) {
        active.get()?.offer(bytes, sampleRate, channels, stream, frameOffset)
    }
    fun discardBuffered() { active.get()?.discardBuffered() }
    override fun close() { active.getAndSet(null)?.close() }

    class Capture internal constructor(private val owns: (Stream) -> Boolean, private val consume: (Block) -> Unit) : AutoCloseable {
        private val queue = ArrayBlockingQueue<Block>(8)
        private val closed = AtomicBoolean()
        val dropped = AtomicLong()
        val failed = AtomicBoolean()
        private val worker = Thread({
            try {
                while (!closed.get()) {
                    val block = queue.poll(50, TimeUnit.MILLISECONDS) ?: continue
                    if (!closed.get() && owns(block.stream)) consume(block)
                }
            } catch (_: InterruptedException) { /* Closing interrupts the worker, never playback. */ }
            catch (_: Exception) { failed.set(true) }
            finally { closed.set(true); queue.clear() }
        }, "soundsible-program-pcm").apply { isDaemon = true; start() }
        internal fun offer(bytes: ByteBuffer, sampleRate: Int, channels: Int, stream: Stream, frameOffset: Long) {
            if (closed.get() || stream.source == "live" || !owns(stream) || channels !in 1..32 || sampleRate <= 0) return
            val view = bytes.asReadOnlyBuffer()
            val frameBytes = channels * 2
            if (view.remaining() % frameBytes != 0) return
            val limit = (65536 / frameBytes) * frameBytes
            if (limit == 0) return
            var frame = frameOffset
            while (view.hasRemaining() && !closed.get()) {
                if (queue.remainingCapacity() == 0) { dropped.incrementAndGet(); return }
                val size = minOf(view.remaining(), limit)
                val copy = ByteArray(size); view.get(copy)
                if (!queue.offer(Block(copy, sampleRate, channels, stream, frame))) { dropped.incrementAndGet(); return }
                frame += size / frameBytes
            }
        }
        internal fun discardBuffered() { queue.clear() }
        override fun close() { if (closed.compareAndSet(false, true)) { queue.clear(); worker.interrupt() } }
    }
}
