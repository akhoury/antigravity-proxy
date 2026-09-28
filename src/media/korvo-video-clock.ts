// Bound gateway JPEG memory and select frames from the device's consumed-PCM
// media clock. No wall-clock extrapolation: an audio underrun freezes video.
// Requests may lead that clock by measured download/display latency; this is
// bounded feedback, not an arbitrary startup delay or extra device frame queue.
export const MAX_VIDEO_FPS = 30;
export class VideoClock<T> {
  readonly frames = new Map<number, T>();
  positionMs: number | null = null;
  lastSent = 0;
  highestSequence = 0;
  ended = false;
  lastAdvanceAt: number;
  leadMs = 0;
  private readonly announcedLead = new Map<number, number>();
  private lastPresented = 0;

  constructor(readonly fps: number, readonly capacity = 48, now = Date.now()) {
    if (!Number.isInteger(fps) || fps < 1 || fps > MAX_VIDEO_FPS || capacity < 4) throw new Error("Invalid video clock limits");
    this.lastAdvanceAt = now;
  }

  get hasCapacity(): boolean { return this.frames.size < this.capacity; }
  // Cover the 600ms anticipation budget plus four in-flight announcements.
  // At 30FPS the old eight-frame history lasted only267ms; stale HTTP requests
  // could expire even though their presentation feedback was still valid.
  get historyFrames(): number { return Math.min(this.capacity - 1, Math.max(8, Math.ceil(this.fps * 0.6) + 4)); }
  pts(sequence: number): number { return (sequence - 1) * 1000 / this.fps; }

  push(sequence: number, value: T): void {
    if (!this.hasCapacity || sequence !== this.highestSequence + 1) throw new Error("Invalid video frame sequence/capacity");
    this.frames.set(sequence, value);
    this.highestSequence = sequence;
  }

  advance(positionMs: unknown, now = Date.now()): boolean {
    if (typeof positionMs !== "number" || !Number.isSafeInteger(positionMs) || positionMs < 0 ||
        positionMs > 24 * 60 * 60 * 1000 || (this.positionMs !== null && positionMs < this.positionMs)) return false;
    if (this.positionMs === null || positionMs > this.positionMs) this.lastAdvanceAt = now;
    this.positionMs = positionMs;
    return true;
  }

  takeDue(): {sequence: number; ptsMs: number; value: T} | undefined {
    if (this.positionMs === null) return;
    let selected = 0;
    for (const sequence of this.frames.keys()) {
      if (sequence > this.lastSent && this.pts(sequence) <= this.positionMs + this.leadMs) selected = sequence;
    }
    if (!selected) return;
    this.lastSent = selected;
    this.announcedLead.set(selected, this.leadMs);
    const value = this.frames.get(selected)!;
    // FPS-aware, bounded announced history; total JPEG capacity is unchanged.
    const retained = this.historyFrames;
    for (const sequence of this.frames.keys()) {
      if (sequence < selected - retained + 1) {
        this.frames.delete(sequence);
        this.announcedLead.delete(sequence);
      }
    }
    return {sequence: selected, ptsMs: this.pts(selected), value};
  }

  observePresentation(sequence: number, audioMs: number): boolean {
    const usedLead = this.announcedLead.get(sequence);
    if (usedLead === undefined || sequence <= this.lastPresented ||
        !Number.isSafeInteger(audioMs) || audioMs < 0 || audioMs > 86400000) return false;
    const observedLatency = audioMs - this.pts(sequence) + usedLead;
    if (observedLatency < 0 || observedLatency > 2000) return false;
    this.lastPresented = sequence;
    // Smooth jitter and cap anticipation to avoid racing far ahead of audio.
    this.leadMs = Math.min(600, Math.max(0, this.leadMs * 0.75 + observedLatency * 0.25));
    return true;
  }

  get finished(): boolean {
    return this.ended && this.positionMs !== null && this.positionMs >= this.highestSequence * 1000 / this.fps;
  }
}
