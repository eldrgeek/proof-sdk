/** Best-effort refresh fallback. Authentication failures stop until the page reloads. */
export class ShareEventPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private failures = 0;
  private authFailures = 0;
  private generation = 0;

  constructor(
    private readonly hasCredential: () => boolean,
    private readonly poll: () => Promise<number>,
    private readonly intervalMs = 1500,
  ) {}

  start(): void {
    if (this.running || this.authFailures >= 3 || !this.hasCredential()) return;
    this.running = true;
    const generation = ++this.generation;
    const schedule = () => {
      if (!this.running || generation !== this.generation || this.authFailures >= 3 || !this.hasCredential()) {
        if (generation === this.generation) this.running = false;
        return;
      }
      this.timer = setTimeout(() => { void tick(); }, Math.min(30_000, this.intervalMs * 2 ** Math.min(this.failures, 5)));
    };
    const tick = async () => {
      this.timer = null;
      if (!this.running || generation !== this.generation || !this.hasCredential()) {
        if (generation === this.generation) this.running = false;
        return;
      }
      let status = 0;
      try { status = await this.poll(); } catch { /* retry transient transport failures */ }
      if (!this.running || generation !== this.generation) return;
      if (status === 401 || status === 403) this.authFailures += 1;
      else if (status >= 200 && status < 300) this.authFailures = 0;
      this.failures = status >= 200 && status < 300 ? 0 : this.failures + 1;
      schedule();
    };
    schedule();
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
