import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export class Logger {
  private ready = false;

  constructor(
    private readonly file: string,
    private readonly maxBytes = 5 * 1024 * 1024,
    private readonly keep = 3,
  ) {}

  log(level: "info" | "warn" | "debug", msg: string): void {
    try {
      if (!this.ready) {
        mkdirSync(path.dirname(this.file), { recursive: true });
        this.ready = true;
      }
      if (existsSync(this.file) && statSync(this.file).size > this.maxBytes) this.rotate();
      appendFileSync(this.file, `${new Date().toISOString()} ${level} ${msg}\n`);
    } catch {
      // Logging must never break the overlay.
    }
  }

  private rotate(): void {
    rmSync(`${this.file}.${this.keep - 1}`, { force: true });
    for (let i = this.keep - 2; i >= 1; i--) {
      if (existsSync(`${this.file}.${i}`)) renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
    }
    renameSync(this.file, `${this.file}.1`);
  }
}
