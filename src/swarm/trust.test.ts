import { describe, expect, it } from "vitest";
import { BetaTrust, reviewReason, shouldQuarantine } from "./trust";

describe("BetaTrust", () => {
  it("starts a fresh agent at the prior mean", () => {
    const t = new BetaTrust();
    expect(t.get("a")).toBeCloseTo(2 / 3);
    expect(t.judged("a")).toBe(0);
  });

  it("drops to 1/3 after three straight disagreements", () => {
    const t = new BetaTrust();
    t.record("a", false);
    t.record("a", false);
    expect(t.record("a", false)).toBeCloseTo(1 / 3);
    expect(t.judged("a")).toBe(3);
  });

  it("climbs with agreements and keeps agents separate", () => {
    const t = new BetaTrust();
    expect(t.record("a", true)).toBeCloseTo(3 / 4);
    expect(t.record("a", true)).toBeCloseTo(4 / 5);
    expect(t.record("a", false)).toBeCloseTo(4 / 6);
    expect(t.get("b")).toBeCloseTo(2 / 3);
    expect(t.judged("b")).toBe(0);
  });

  it("honours a custom prior", () => {
    const t = new BetaTrust({ priorAgree: 1, priorDisagree: 1 });
    expect(t.get("a")).toBe(0.5);
    expect(t.record("a", true)).toBeCloseTo(2 / 3);
  });
});

describe("reviewReason", () => {
  const base = { judged: 5, trust: 0.8, probation: 3, reviewTrust: 0.6, auditDraw: 0.9, auditRate: 0.1 };

  it("returns null for a trusted veteran that missed the audit draw", () => {
    expect(reviewReason(base)).toBeNull();
  });

  it("puts probation first", () => {
    expect(reviewReason({ ...base, judged: 2, trust: 0.1, auditDraw: 0 })).toBe("probation");
  });

  it("puts low trust before audit", () => {
    expect(reviewReason({ ...base, trust: 0.59, auditDraw: 0 })).toBe("low-trust");
    expect(reviewReason({ ...base, trust: 0.6 })).toBeNull();
  });

  it("audits when the draw falls under the rate", () => {
    expect(reviewReason({ ...base, auditDraw: 0.05 })).toBe("audit");
    expect(reviewReason({ ...base, auditDraw: 0.1 })).toBeNull();
    expect(reviewReason({ ...base, auditDraw: 0, auditRate: 0 })).toBeNull();
  });
});

describe("shouldQuarantine", () => {
  const base = { judged: 3, trust: 0.3, probation: 3, quarantineTrust: 0.4 };

  it("quarantines a low-trust agent after probation", () => {
    expect(shouldQuarantine(base)).toBe(true);
  });

  it("spares agents still on probation or at the threshold", () => {
    expect(shouldQuarantine({ ...base, judged: 2 })).toBe(false);
    expect(shouldQuarantine({ ...base, trust: 0.4 })).toBe(false);
  });

  it("quarantines a compromised agent after three misses with the defaults", () => {
    const t = new BetaTrust();
    for (let i = 0; i < 3; i++) t.record("evil", false);
    expect(shouldQuarantine({ judged: t.judged("evil"), trust: t.get("evil"), probation: 3, quarantineTrust: 0.4 })).toBe(true);
  });
});
