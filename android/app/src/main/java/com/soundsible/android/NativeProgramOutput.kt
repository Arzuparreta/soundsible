package com.soundsible.android

/** In-process post-DSP attachment for native Live and instrumentation; no exported IPC. */
internal object NativeProgramOutput {
    @Volatile var playing = false; private set
    fun playbackChanged(active: Boolean) { playing = active }
    private data class Owner(val tap: ProgramPcmTap, val generation: () -> Long)
    @Volatile private var owner: Owner? = null
    @Synchronized fun bind(tap: ProgramPcmTap, generation: () -> Long) {
        owner?.tap?.takeIf { it !== tap }?.close()
        playing = false; owner = Owner(tap, generation)
    }
    @Synchronized fun unbind(tap: ProgramPcmTap) {
        if (owner?.tap === tap) { owner = null; playing = false; tap.close() }
    }
    fun subscribe(generation: Long, consume: (ProgramPcmTap.Block) -> Unit): ProgramPcmTap.Capture {
        val current = owner ?: error("No native programme output")
        require(current.generation() == generation)
        return current.tap.subscribe({ stream -> owner === current && stream.generation == generation && current.generation() == generation }, consume)
    }
}
