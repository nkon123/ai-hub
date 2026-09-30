import { describe, expect, it } from "vitest";
import { avatarInitial, avatarTone } from "./conversationAvatar";

describe("avatarInitial", () => {
  it("uses the first letter, Korean included, uppercasing Latin", () => {
    expect(avatarInitial("메일 요약")).toBe("메");
    expect(avatarInitial("hello world")).toBe("H");
  });

  it("skips leading spaces and symbols", () => {
    expect(avatarInitial("  ?? 질문")).toBe("질");
  });

  it("falls back to # when there is no letter or digit", () => {
    expect(avatarInitial("  ...  ")).toBe("#");
    expect(avatarInitial("")).toBe("#");
  });
});

describe("avatarTone", () => {
  it("is stable for the same id and always a bg+text pair", () => {
    const a = avatarTone("6f1c2c9e-aaaa");
    expect(avatarTone("6f1c2c9e-aaaa")).toBe(a);
    expect(a).toMatch(/^bg-\w+-100 text-\w+-700$/);
  });

  it("spreads different ids over more than one tone", () => {
    const tones = new Set(Array.from({ length: 40 }, (_, i) => avatarTone(`conv-${i}`)));
    expect(tones.size).toBeGreaterThan(1);
  });
});
