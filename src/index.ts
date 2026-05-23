#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { OpenReplayClient, AuthError, rangeFromHours } from "./openreplay.js";
import { timeseriesPayload, tablePayload, funnelPayload } from "./cards.js";

// stdout is reserved for JSON-RPC framing; route stray console output to stderr.
console.log = console.error;

// dotenv is a dev convenience for local .env files; MCP hosts inject env directly.
// quiet: true suppresses dotenv v17's stdout banner, which would corrupt the stream.
try {
  (await import("dotenv")).config({ quiet: true });
} catch {
  // dotenv not installed — env comes from the host
}

const APP_URL =
  process.env.OPENREPLAY_URL ||
  process.env.OPENREPLAY_BACKEND_URL ||
  process.env.OPENREPLAY_API_URL ||
  "https://app.openreplay.com";
const DEFAULT_PROJECT_ID = process.env.OPENREPLAY_PROJECT_ID || "";

const client = new OpenReplayClient({
  appUrl: APP_URL,
  email: process.env.OPENREPLAY_EMAIL,
  password: process.env.OPENREPLAY_PASSWORD,
});

function resolveSiteId(siteId?: string): string {
  const id = siteId || DEFAULT_PROJECT_ID;
  if (!id) {
    throw new Error(
      "No project id. Pass siteId, or set OPENREPLAY_PROJECT_ID. Call list_projects to discover ids.",
    );
  }
  return id;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

// Wrap a tool body so auth/API errors surface as readable tool errors, not crashes.
function tool(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  return fn().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    const hint =
      err instanceof AuthError
        ? " (set OPENREPLAY_EMAIL / OPENREPLAY_PASSWORD or call the login tool)"
        : "";
    return { content: [{ type: "text", text: `Error: ${msg}${hint}` }], isError: true };
  });
}

const server = new McpServer({ name: "openreplay-mcp", version: "0.2.0" });

server.registerTool(
  "login",
  {
    title: "Log in to OpenReplay",
    description:
      "Authenticate against OpenReplay with email/password to obtain a JWT. Uses OPENREPLAY_EMAIL/OPENREPLAY_PASSWORD if args are omitted. The JWT is cached, so this is usually automatic.",
    inputSchema: {
      email: z.string().optional().describe("Account email (defaults to OPENREPLAY_EMAIL)"),
      password: z.string().optional().describe("Account password (defaults to OPENREPLAY_PASSWORD)"),
    },
  },
  ({ email, password }) =>
    tool(async () => {
      const user = await client.login(email, password);
      return json({ authenticated: true, instance: client.appUrl, user });
    }),
);

server.registerTool(
  "auth_status",
  {
    title: "Check auth status",
    description: "Report whether the server currently holds a valid OpenReplay JWT.",
    inputSchema: {},
  },
  () => tool(async () => json({ authenticated: client.isAuthenticated(), instance: client.appUrl })),
);

server.registerTool(
  "list_projects",
  {
    title: "List projects",
    description:
      "List OpenReplay projects (sites) in the organization with their numeric projectId (siteId) and name.",
    inputSchema: {},
  },
  () => tool(async () => json(await client.listProjects())),
);

server.registerTool(
  "search_sessions",
  {
    title: "Search sessions",
    description:
      "Search recorded sessions for a project over a time window. Returns total count and session summaries (sessionId, duration, user, browser, country, errors). Pass raw OpenReplay filter objects via `filters` for advanced filtering.",
    inputSchema: {
      siteId: z.string().optional().describe("Project id (defaults to OPENREPLAY_PROJECT_ID)"),
      hoursBack: z.number().int().positive().default(24).describe("Lookback window in hours"),
      limit: z.number().int().min(1).max(200).default(10),
      page: z.number().int().min(1).default(1),
      filters: z.array(z.unknown()).optional().describe("Raw OpenReplay filter objects"),
    },
  },
  ({ siteId, hoursBack, limit, page, filters }) =>
    tool(async () => {
      const id = resolveSiteId(siteId);
      const result = await client.searchSessions(id, rangeFromHours(hoursBack), { limit, page, filters });
      return json({
        total: result.total,
        returned: result.sessions.length,
        sessions: result.sessions.map((s) => ({
          ...s,
          replayUrl: client.replayUrl(id, s.sessionId),
        })),
      });
    }),
);

server.registerTool(
  "get_session_events",
  {
    title: "Get session events",
    description:
      "Get all events for a single session: page locations, clicks, inputs, errors, network requests, performance and custom events.",
    inputSchema: {
      sessionId: z.string().describe("The session id"),
      siteId: z.string().optional().describe("Project id (defaults to OPENREPLAY_PROJECT_ID)"),
    },
  },
  ({ sessionId, siteId }) =>
    tool(async () => json(await client.getSessionEvents(resolveSiteId(siteId), sessionId))),
);

server.registerTool(
  "get_session_replay",
  {
    title: "Get session replay metadata",
    description:
      "Get replay metadata for a session (duration, user, device, tracker version) plus a deep link to watch the replay in the OpenReplay dashboard.",
    inputSchema: {
      sessionId: z.string().describe("The session id"),
      siteId: z.string().optional().describe("Project id (defaults to OPENREPLAY_PROJECT_ID)"),
    },
  },
  ({ sessionId, siteId }) =>
    tool(async () => {
      const id = resolveSiteId(siteId);
      const data = await client.getSessionReplay(id, sessionId);
      return json({ replayUrl: client.replayUrl(id, sessionId), session: data });
    }),
);

server.registerTool(
  "get_sessions_over_time",
  {
    title: "Sessions over time",
    description: "Timeseries of session counts bucketed across the lookback window.",
    inputSchema: {
      siteId: z.string().optional(),
      hoursBack: z.number().int().positive().default(168),
      density: z.number().int().min(1).max(120).default(24).describe("Number of buckets"),
    },
  },
  ({ siteId, hoursBack, density }) =>
    tool(async () => {
      const id = resolveSiteId(siteId);
      return json(await client.card(id, timeseriesPayload(rangeFromHours(hoursBack), density)));
    }),
);

server.registerTool(
  "get_top",
  {
    title: "Top breakdown table",
    description:
      "Top values for a dimension over the window. metricOf accepted values: location (top pages), userBrowser, userOs, userCountry, userDevice, userId, referrer, fetch, jsException, screenResolution, sessions, issue.",
    inputSchema: {
      metricOf: z
        .string()
        .describe("Dimension, e.g. location | userBrowser | userCountry | userOs | userDevice | userId | referrer | fetch | jsException | screenResolution"),
      siteId: z.string().optional(),
      hoursBack: z.number().int().positive().default(168),
      limit: z.number().int().min(1).max(200).default(20),
    },
  },
  ({ metricOf, siteId, hoursBack, limit }) =>
    tool(async () => {
      const id = resolveSiteId(siteId);
      return json(await client.card(id, tablePayload(rangeFromHours(hoursBack), metricOf, limit)));
    }),
);

server.registerTool(
  "get_funnel",
  {
    title: "Funnel analysis",
    description:
      "Step-by-step conversion funnel. Each step is either a URL path string (shorthand for a LOCATION step) or an object {type, value, operator} for event types like CLICK, INPUT, CUSTOM.",
    inputSchema: {
      steps: z
        .array(
          z.union([
            z.string(),
            z.object({
              type: z.string(),
              value: z.string().optional(),
              operator: z.string().optional(),
            }),
          ]),
        )
        .min(2)
        .describe("Ordered funnel steps (>= 2)"),
      siteId: z.string().optional(),
      hoursBack: z.number().int().positive().default(168),
    },
  },
  ({ steps, siteId, hoursBack }) =>
    tool(async () => {
      const id = resolveSiteId(siteId);
      return json(await client.card(id, funnelPayload(rangeFromHours(hoursBack), steps)));
    }),
);

async function main() {
  await client.loadPersisted();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`OpenReplay MCP server running on stdio (instance: ${client.appUrl})`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
