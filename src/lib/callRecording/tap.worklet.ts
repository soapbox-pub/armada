/**
 * Audio-thread tap for call recording: batches its (mono) input and posts each
 * batch, stamped with the context frame of its first sample, straight to the
 * recording worker over the port it is handed. The stamp is what lines every
 * voice's file up with the others — they all share this context's clock.
 * A peer-to-peer call's capture (`src/lib/irohVoice/audio.ts`) reuses it with a
 * 20 ms `batch`, one Opus frame per post.
 */

declare const currentFrame: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const BATCH = 4096;

class RecordTap extends AudioWorkletProcessor {
  private out: MessagePort | null = null;
  private readonly batch: number;
  private buf: Float32Array;
  private fill = 0;
  private start = 0;
  private next = -1;
  private stopped = false;

  constructor(options?: { processorOptions?: { batch?: number } }) {
    super();
    const batch = options?.processorOptions?.batch;
    this.batch = typeof batch === "number" && batch > 0 ? batch : BATCH;
    this.buf = new Float32Array(this.batch);
    this.port.onmessage = (event: MessageEvent<{ port?: MessagePort; flush?: boolean }>) => {
      if (event.data.port) this.out = event.data.port;
      if (event.data.flush) {
        this.flush();
        this.out?.postMessage({ done: true });
        this.stopped = true;
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
    const input = inputs[0]?.[0];
    // No source connected: nothing to post, and the gap is the worker's to fill.
    if (!input) return true;
    if (this.fill > 0 && currentFrame !== this.next) this.flush();
    if (this.fill === 0) this.start = currentFrame;
    let i = 0;
    while (i < input.length) {
      const n = Math.min(input.length - i, this.batch - this.fill);
      this.buf.set(input.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      if (this.fill === this.batch) {
        this.flush();
        this.start = currentFrame + i;
      }
    }
    this.next = currentFrame + input.length;
    return true;
  }

  private flush(): void {
    if (this.fill > 0 && this.out) {
      const d = this.buf.slice(0, this.fill);
      this.out.postMessage({ f: this.start, d }, [d.buffer]);
    }
    this.fill = 0;
  }
}

registerProcessor("armada-record-tap", RecordTap);
