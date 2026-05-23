import axios from "axios";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const CONFIG_DIR = path.join(os.homedir(), ".openreplay-mcp");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export interface Project {
  projectId: string;
  name: string;
}

export interface SessionSummary {
  sessionId: string;
  duration?: number;
  startTs?: number;
  eventsCount?: number;
  errorsCount?: number;
  pagesCount?: number;
  userId?: string | null;
  userBrowser?: string;
  userOs?: string;
  userCountry?: string;
  userDeviceType?: string;
  [key: string]: unknown;
}

export interface LoginResult {
  email?: string;
  name?: string;
}

interface PersistedState {
  appUrl: string;
  jwt: string | null;
}

// Build a full API URL from the user-facing OpenReplay URL and an endpoint path.
// SaaS (app.openreplay.com -> api.openreplay.com) drops the /api segment;
// self-hosted keeps it. Mirrors the official OpenReplay MCP app behaviour.
export function buildApiUrl(appUrl: string, endpoint: string): string {
  const trimmed = appUrl.replace(/\/+$/, "");
  try {
    const u = new URL(trimmed);
    if (u.hostname === "app.openreplay.com") {
      const host = `${u.protocol}//api.openreplay.com`;
      const stripped = endpoint.replace(/^\/v2\/api\//, "/v2/").replace(/^\/api\//, "/");
      return `${host}${stripped}`;
    }
  } catch {
    // not a parseable URL — treat as self-hosted host string
  }
  if (endpoint.startsWith("/v2/api/") || endpoint.startsWith("/api/")) {
    return `${trimmed}${endpoint}`;
  }
  return `${trimmed}/api${endpoint}`;
}

export class AuthError extends Error {}

export interface ClientOptions {
  appUrl: string;
  email?: string;
  password?: string;
}

export class OpenReplayClient {
  readonly appUrl: string;
  private email?: string;
  private password?: string;
  private jwt: string | null = null;
  projects: Project[] = [];

  constructor(opts: ClientOptions) {
    this.appUrl = opts.appUrl.replace(/\/+$/, "");
    this.email = opts.email;
    this.password = opts.password;
  }

  isAuthenticated(): boolean {
    return Boolean(this.jwt);
  }

  async loadPersisted(): Promise<void> {
    try {
      const raw = await fs.readFile(CONFIG_FILE, "utf-8");
      const data: PersistedState = JSON.parse(raw);
      // A JWT minted against a different instance is useless here.
      if (data.appUrl === this.appUrl && data.jwt) {
        this.jwt = data.jwt;
      }
    } catch {
      // no persisted state — first run or cleared
    }
  }

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(CONFIG_DIR, { recursive: true });
      const data: PersistedState = { appUrl: this.appUrl, jwt: this.jwt };
      await fs.writeFile(CONFIG_FILE, JSON.stringify(data, null, 2));
    } catch {
      // persistence is best-effort
    }
  }

  async login(email?: string, password?: string): Promise<LoginResult> {
    const e = email ?? this.email;
    const p = password ?? this.password;
    if (!e || !p) {
      throw new AuthError(
        "No credentials. Pass email/password to the login tool or set OPENREPLAY_EMAIL / OPENREPLAY_PASSWORD.",
      );
    }
    this.email = e;
    this.password = p;

    const url = buildApiUrl(this.appUrl, "/login");
    let resp;
    try {
      resp = await axios.post(
        url,
        { email: e, password: p },
        { headers: { "Content-Type": "application/json", Accept: "application/json" } },
      );
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        const detail =
          (err.response.data as { errors?: string[] })?.errors?.join(", ") ??
          err.response.statusText;
        throw new AuthError(`Login failed (${err.response.status}): ${detail}`);
      }
      throw err;
    }

    const body = resp.data as {
      jwt?: string;
      data?: { jwt?: string; user?: { email?: string; name?: string; tenantId?: number } };
    };
    const jwt = body.jwt ?? body.data?.jwt;
    if (!jwt) {
      throw new AuthError("Login succeeded but no JWT was returned by OpenReplay.");
    }
    this.jwt = jwt;
    await this.persist();
    return {
      email: body.data?.user?.email ?? e,
      name: body.data?.user?.name,
    };
  }

  // Authenticated request with one transparent re-login on 401/403.
  async request<T = unknown>(
    endpoint: string,
    options: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown } = {},
    retry = true,
  ): Promise<T> {
    if (!this.jwt) {
      await this.login();
    }
    const url = buildApiUrl(this.appUrl, endpoint);
    try {
      const resp = await axios.request<T>({
        url,
        method: options.method ?? "GET",
        data: options.body,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${this.jwt}`,
        },
      });
      return resp.data;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        const status = err.response.status;
        if ((status === 401 || status === 403) && retry && (this.email && this.password)) {
          this.jwt = null;
          await this.login();
          return this.request<T>(endpoint, options, false);
        }
        const detail =
          typeof err.response.data === "string"
            ? err.response.data
            : JSON.stringify(err.response.data);
        throw new Error(`OpenReplay API ${status} on ${endpoint}: ${detail}`);
      }
      throw err;
    }
  }

  async listProjects(): Promise<Project[]> {
    const { data } = await this.request<{ data: Array<{ projectId: number | string; name: string }> }>(
      "/projects",
    );
    this.projects = data.map((pr) => ({ projectId: String(pr.projectId), name: pr.name }));
    return this.projects;
  }

  // Normalize a raw filter object so the OpenReplay v1 API accepts it.
  // The API requires `value` to be an array and `name` to be present.
  private normalizeFilter(f: unknown): unknown {
    if (typeof f !== "object" || f === null) return f;
    const filter = f as Record<string, unknown>;
    return {
      ...filter,
      name: filter.name ?? filter.type,
      value: Array.isArray(filter.value) ? filter.value : filter.value !== undefined ? [filter.value] : [],
    };
  }

  async searchSessions(
    siteId: string,
    range: TimeRange,
    opts: { limit?: number; page?: number; filters?: unknown[] } = {},
  ): Promise<{ total: number; sessions: SessionSummary[] }> {
    const payload = {
      filters: (opts.filters ?? []).map((f) => this.normalizeFilter(f)),
      startTimestamp: range.startTimestamp,
      endTimestamp: range.endTimestamp,
      startDate: range.startTimestamp,
      endDate: range.endTimestamp,
      sort: "startTs",
      order: "desc",
      eventsOrder: "then",
      limit: opts.limit ?? 10,
      page: opts.page ?? 1,
    };
    const { data } = await this.request<{ data: { total: number; sessions: SessionSummary[] } }>(
      `/${siteId}/sessions/search`,
      { method: "POST", body: payload },
    );
    return data;
  }

  async getSessionEvents(siteId: string, sessionId: string): Promise<unknown> {
    const { data } = await this.request<{ data: unknown }>(`/${siteId}/sessions/${sessionId}/events`);
    return data;
  }

  async getSessionReplay(siteId: string, sessionId: string): Promise<unknown> {
    const { data } = await this.request<{ data: unknown }>(`/${siteId}/sessions/${sessionId}/replay`);
    return data;
  }

  // Generic metric card. metricType drives the shape (timeseries/table/funnel/webVital/pathAnalysis).
  async card(siteId: string, payload: Record<string, unknown>): Promise<unknown> {
    const { data } = await this.request<{ data: unknown }>(`/${siteId}/cards/try`, {
      method: "POST",
      body: payload,
    });
    return data;
  }

  replayUrl(siteId: string, sessionId: string): string {
    const jwtParam = this.jwt ? `?jwt=${encodeURIComponent(this.jwt)}` : "";
    return `${this.appUrl}/${siteId}/session/${sessionId}${jwtParam}`;
  }
}

export interface TimeRange {
  startTimestamp: number;
  endTimestamp: number;
}

export function rangeFromHours(hoursBack: number): TimeRange {
  const end = Date.now();
  const start = end - hoursBack * 60 * 60 * 1000;
  return { startTimestamp: Math.floor(start / 1000) * 1000, endTimestamp: Math.floor(end / 1000) * 1000 };
}
