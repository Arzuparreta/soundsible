/** Load DJ-only observation code on demand, independently of playback. */
import type { DiagnosticFacts } from './playbackDiagnostics';
type Recorder = ReturnType<typeof import('./djEvidenceRecorder').createDjEvidence>;
type Factory = typeof import('./djEvidenceRecorder').createDjEvidence;
export function createDjEvidence(emit: (event: string, facts: DiagnosticFacts) => void,
  id: () => string, now = () => performance.now(),
  load: () => Promise<Factory> = () => import('./djEvidenceRecorder').then(module => module.createDjEvidence)): Recorder {
  let recorder: Recorder | undefined, loading = false;
  let session: { id: string; time: number; known: boolean } | undefined;
  const pending: Array<(recorder: Recorder) => void> = [];
  function context(): DiagnosticFacts {
    return recorder?.context() ?? (session ? { djSession: session.id } : {});
  }
  function send(operation: (recorder: Recorder) => void): void {
    if (recorder) { operation(recorder); return; }
    if (pending.length < 128) pending.push(operation);
    else if (session) session.known = false;
    if (loading) return;
    loading = true;
    void load().then(factory => {
      recorder = factory(emit, id, now);
      for (const operation of pending.splice(0)) operation(recorder);
    }).catch(() => {
      pending.length = 0;
      try { emit('dj.capture_unavailable', context()); } catch { /* Passive only. */ }
    });
  }
  function start(direction: number, known = true): void {
    const owner = { id: id(), time: now(), known };
    session = owner;
    send(recorder => recorder.start(direction, owner.known, owner.id, owner.time));
  }
  function end(reason: string): void {
    if (session || recorder) send(recorder => recorder.end(reason));
    session = undefined;
  }
  function sync(active: boolean, direction: number): void {
    if (!active) { if (session || recorder) end('inactive'); return; }
    if (!session && !recorder) start(direction, false);
    send(recorder => recorder.sync(active, direction));
  }
  function arm(...args: Parameters<Recorder['arm']>): DiagnosticFacts {
    if (recorder) return recorder.arm(...args);
    if (session) session.known = false; // Execution before observer load is incomplete.
    send(recorder => recorder.arm(...args));
    return context();
  }
  const forwarded = Object.fromEntries(['select', 'route', 'refine', 'interaction', 'outcome'].map(name =>
    [name, (...args: unknown[]) => send(recorder => (recorder[name as keyof Recorder] as (...args: unknown[]) => void)(...args))]));
  return { ...forwarded, context, start, sync, end, arm } as Recorder;
}
