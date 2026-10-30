/** A pre-fader PCM observation, not a measurement of physical speakers.
 * Read channels separately: a mono downmix would report anti-phase stereo as
 * silence. The branch is muted; the main signal passes through unchanged. */
export function createSignalMeter(context: AudioContext): { node: AudioNode; read: () => number | null } | null {
  if (typeof context.createAnalyser !== 'function') return null;
  const analysers: AnalyserNode[] = [];
  let input: AudioNode;
  try {
    if (typeof context.createChannelSplitter === 'function') {
      const tap = context.createGain();
      tap.gain.value = 1;
      input = tap;
      const split = context.createChannelSplitter(2);
      const silent = context.createGain();
      silent.gain.value = 0;
      tap.connect(split);
      silent.connect(context.destination);
      for (let channel = 0; channel < 2; channel++) {
        const node = context.createAnalyser();
        node.channelCount = 1;
        node.channelCountMode = 'explicit';
        node.fftSize = 256;
        split.connect(node, channel).connect(silent);
        analysers.push(node);
      }
    } else {
      const node = context.createAnalyser();
      node.fftSize = 256;
      analysers.push(node);
      input = node;
    }
  } catch { return null; }
  const samples = new Float32Array(256);
  return { node: input, read() {
    if (context.state !== 'running') return null;
    let largest = 0;
    for (const node of analysers) {
      if (typeof node.getFloatTimeDomainData !== 'function') return null;
      try { node.getFloatTimeDomainData(samples); } catch { return null; }
      let power = 0;
      for (const sample of samples) power += sample * sample;
      if (!Number.isFinite(power)) return null;
      largest = Math.max(largest, Math.sqrt(power / samples.length));
    }
    return largest;
  } };
}
