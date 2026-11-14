import { describe, expect, it } from "vitest";
import { resumeId } from "../src/core/resume.js";

describe("resumeId", () => {
  const now = new Date("2026-11-14T20:00:00Z");
  const at = (iso: string) => ({ id: "s-1", lastUsed: iso });

  it("resumes a conversation used inside the window", () => {
    expect(resumeId(at("2026-11-14T09:00:00Z"), now, 12)).toBe("s-1");
  });

  it("starts a new one after the window, with resume off, or with nothing saved", () => {
    expect(resumeId(at("2026-11-14T07:59:59Z"), now, 12)).toBeNull();
    expect(resumeId(at("2026-11-14T19:00:00Z"), now, 0)).toBeNull();
    expect(resumeId(undefined, now, 12)).toBeNull();
  });

  it("ignores a broken or future time", () => {
    expect(resumeId(at("yesterday"), now, 12)).toBeNull();
    expect(resumeId(at("2026-11-15T00:00:00Z"), now, 12)).toBeNull();
  });
});
