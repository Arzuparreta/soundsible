/*
 * WebRTC Java recorder ABI adapted for Soundsible's programme PCM input.
 * No AudioRecord is instantiated and no microphone permission is required.
 * ABI names/signatures derive from GetStream WebRTC 1.3.10 (WebRTC BSD license).
 */
package org.webrtc.audio;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.atomic.AtomicReference;
import org.webrtc.CalledByNative;

/** JNI-compatible recording side of the ADM; input is a bounded application-owned PCM source. */
public class WebRtcAudioRecord {
    public static final int DEFAULT_AUDIO_SOURCE = android.media.MediaRecorder.AudioSource.DEFAULT;
    public static final int DEFAULT_AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT;
    public interface ProgramInput { void read(byte[] destination, int sampleRate, int channels); }
    private static final AtomicReference<ProgramInput> input = new AtomicReference<>();
    public static boolean attach(ProgramInput owner) { return input.compareAndSet(null, owner); }
    public static void detach(ProgramInput owner) { input.compareAndSet(owner, null); }
    private final JavaAudioDeviceModule.AudioRecordStateCallback stateCallback;
    private final JavaAudioDeviceModule.SamplesReadyCallback samplesCallback;
    private ByteBuffer buffer;
    private long nativeAudioRecord;
    private int sampleRate, channels;
    private volatile boolean running, muted;
    private Thread worker;

    @CalledByNative WebRtcAudioRecord(Context context, AudioManager manager) {
        this(context, null, manager, DEFAULT_AUDIO_SOURCE, DEFAULT_AUDIO_FORMAT, null, null, null, false, false);
    }
    public WebRtcAudioRecord(Context context, ScheduledExecutorService scheduler, AudioManager manager,
        int source, int format, JavaAudioDeviceModule.AudioRecordErrorCallback errors,
        JavaAudioDeviceModule.AudioRecordStateCallback state, JavaAudioDeviceModule.SamplesReadyCallback samples,
        boolean aec, boolean ns) {
        if (format != DEFAULT_AUDIO_FORMAT) throw new IllegalArgumentException("PCM16 required");
        stateCallback = state; samplesCallback = samples;
    }
    @CalledByNative public void setNativeAudioRecord(long pointer) { nativeAudioRecord = pointer; }
    @CalledByNative boolean isAcousticEchoCancelerSupported() { return false; }
    @CalledByNative boolean isNoiseSuppressorSupported() { return false; }
    boolean isAudioConfigVerified() { return true; }
    boolean isAudioSourceMatchingRecordingSession() { return true; }
    @CalledByNative private boolean enableBuiltInAEC(boolean enabled) { return !enabled; }
    @CalledByNative private boolean enableBuiltInNS(boolean enabled) { return !enabled; }
    @CalledByNative private int initRecording(int rate, int count) {
        if (running || rate != 48000 || count != 2) return -1;
        sampleRate = rate; channels = count;
        buffer = ByteBuffer.allocateDirect(rate / 100 * count * 2);
        nativeCacheDirectBufferAddress(nativeAudioRecord, buffer);
        return rate / 100;
    }
    void setPreferredDevice(AudioDeviceInfo device) { /* Programme PCM has no recording device. */ }
    @CalledByNative private boolean startRecording() {
        if (running || buffer == null) return false;
        running = true;
        worker = new Thread(() -> {
            final byte[] bytes = new byte[buffer.capacity()];
            long next = System.nanoTime();
            if (stateCallback != null) stateCallback.onWebRtcAudioRecordStart();
            try {
                while (running) {
                    Arrays.fill(bytes, (byte) 0);
                    ProgramInput selected = input.get();
                    if (!muted && selected != null) selected.read(bytes, sampleRate, channels);
                    if (!running) break;
                    buffer.clear(); buffer.put(bytes);
                    nativeDataIsRecorded(nativeAudioRecord, bytes.length, System.nanoTime());
                    if (samplesCallback != null) samplesCallback.onWebRtcAudioRecordSamplesReady(
                        new JavaAudioDeviceModule.AudioSamples(DEFAULT_AUDIO_FORMAT, channels, sampleRate, bytes.clone()));
                    next += 10_000_000L;
                    long wait = next - System.nanoTime();
                    if (wait > 0) java.util.concurrent.locks.LockSupport.parkNanos(wait);
                    else if (wait < -50_000_000L) next = System.nanoTime(); // Never replay a backlog after suspension.
                }
            } finally { running = false; if (stateCallback != null) stateCallback.onWebRtcAudioRecordStop(); }
        }, "soundsible-live-input");
        worker.setDaemon(true); worker.start(); return true;
    }
    @CalledByNative private boolean stopRecording() {
        running = false;
        if (worker != null) {
            java.util.concurrent.locks.LockSupport.unpark(worker);
            try { worker.join(2000); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
            if (worker.isAlive()) return false;
        }
        worker = null; buffer = null; return true;
    }
    public void setMicrophoneMute(boolean mute) { muted = mute; }
    public boolean setNoiseSuppressorEnabled(boolean enabled) { return !enabled; }
    static ScheduledExecutorService newDefaultScheduler() { return Executors.newSingleThreadScheduledExecutor(); }
    private native void nativeCacheDirectBufferAddress(long pointer, ByteBuffer bytes);
    private native void nativeDataIsRecorded(long pointer, int bytes, long timestampNs);
}
