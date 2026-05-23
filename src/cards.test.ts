import { describe, it, expect } from "vitest";
import { timeseriesPayload, tablePayload, funnelPayload } from "./cards.js";

const range = { startTimestamp: 1000, endTimestamp: 2000 };

describe("timeseriesPayload", () => {
  it("builds a sessionCount timeseries with the given density", () => {
    const p = timeseriesPayload(range, 12);
    expect(p.metricType).toBe("timeseries");
    expect(p.metricOf).toBe("sessionCount");
    expect(p.density).toBe(12);
    expect(p.startTimestamp).toBe(1000);
    expect(p.endTimestamp).toBe(2000);
    expect(p.series).toHaveLength(1);
  });
});

describe("tablePayload", () => {
  it("builds a table for the requested dimension", () => {
    const p = tablePayload(range, "userBrowser", 5);
    expect(p.metricType).toBe("table");
    expect(p.metricOf).toBe("userBrowser");
    expect(p.limit).toBe(5);
  });
});

describe("funnelPayload", () => {
  it("turns a bare string into a LOCATION contains step", () => {
    const p = funnelPayload(range, ["/app"]);
    const filters = p.series[0].filter.filters as Array<Record<string, unknown>>;
    expect(filters).toHaveLength(1);
    expect(filters[0]).toMatchObject({
      type: "LOCATION",
      name: "LOCATION",
      value: ["/app"],
      operator: "contains",
      isEvent: true,
    });
  });

  it("requires both type and name on every step (v1.x schema)", () => {
    const p = funnelPayload(range, ["/a", { type: "CLICK", value: "Buy", operator: "is" }]);
    const filters = p.series[0].filter.filters as Array<Record<string, unknown>>;
    expect(filters).toHaveLength(2);
    for (const f of filters) {
      expect(f).toHaveProperty("type");
      expect(f).toHaveProperty("name");
      expect(f.type).toBe(f.name);
    }
    expect(filters[1]).toMatchObject({ type: "CLICK", value: ["Buy"], operator: "is" });
  });

  it("emits an empty value array for a valueless event step", () => {
    const p = funnelPayload(range, ["/a", { type: "CUSTOM" }]);
    const filters = p.series[0].filter.filters as Array<Record<string, unknown>>;
    expect(filters[1]).toMatchObject({ type: "CUSTOM", name: "CUSTOM", value: [] });
  });
});
