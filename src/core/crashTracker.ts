export class CrashTracker {
  private times: number[] = [];
  private _gaveUp = false;

  constructor(private readonly o: { max: number; windowMs: number; now: () => number }) {}

  get gaveUp(): boolean {
    return this._gaveUp;
  }

  /** Records an exit. Returns true when there have been too many. */
  record(): boolean {
    const t = this.o.now();
    this.times = [...this.times.filter((x) => t - x < this.o.windowMs), t];
    if (this.times.length >= this.o.max) this._gaveUp = true;
    return this._gaveUp;
  }

  reset(): void {
    this.times = [];
    this._gaveUp = false;
  }
}
