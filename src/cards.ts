import type { TimeRange } from "./openreplay.js";

// Metric-card payload builders for POST /{siteId}/cards/try.
// Shapes ported from the official OpenReplay MCP app (ee/mcp_app/lib/api.ts).

function series(filters: unknown[] = [], name = "Series 1") {
  return [
    {
      name,
      filter: {
        filters,
        excludes: [],
        eventsOrder: "then",
        startTimestamp: 0,
        endTimestamp: 0,
        page: 1,
        limit: 10,
      },
    },
  ];
}

export function timeseriesPayload(range: TimeRange, density = 24, filters: unknown[] = []) {
  return {
    ...range,
    density,
    metricOf: "sessionCount",
    metricType: "timeseries",
    metricFormat: "sessionCount",
    viewType: "lineChart",
    name: "Sessions Over Time",
    series: series(filters, "Sessions"),
    page: 1,
    limit: 20,
    sortOrder: "desc",
  };
}

// metricOf examples: "locations" (top pages), "userBrowser", "userOs",
// "userCountry", "userDevice", "referrer".
export function tablePayload(range: TimeRange, metricOf: string, limit = 20, filters: unknown[] = []) {
  return {
    ...range,
    density: 24,
    metricOf,
    metricValue: [],
    metricType: "table",
    metricFormat: "sessionCount",
    viewType: "table",
    name: `Top ${metricOf}`,
    series: series(filters),
    page: 1,
    rows: 5,
    limit,
    sortOrder: "desc",
  };
}

export type FunnelStep = string | { type: string; value?: string; operator?: string };

// A bare string is shorthand for a LOCATION step matching a URL path (contains).
// Self-hosted v1.x requires both `type` and `name` on each event filter.
function resolveFunnelStep(step: FunnelStep) {
  const isShorthand = typeof step === "string";
  const eventName = isShorthand ? "LOCATION" : step.type;
  const value = isShorthand ? step : step.value;
  const operator = isShorthand ? "contains" : step.operator ?? "is";

  return {
    type: eventName,
    name: eventName,
    value: value ? [value] : [],
    operator,
    dataType: "string",
    isEvent: true,
  };
}

export function funnelPayload(range: TimeRange, steps: FunnelStep[], filters: unknown[] = []) {
  const stepFilters = steps.map(resolveFunnelStep);
  return {
    ...range,
    density: 24,
    metricOf: "sessionCount",
    metricValue: [],
    metricType: "funnel",
    metricFormat: "sessionCount",
    viewType: "chart",
    name: "Funnel Analysis",
    series: series([...stepFilters, ...filters]),
    page: 1,
    limit: 20,
    sortOrder: "desc",
  };
}
