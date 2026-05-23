import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// Mock axios (default export with post/request/isAxiosError) and fs (no disk writes).
vi.mock("axios", () => ({
  default: {
    post: vi.fn(),
    request: vi.fn(),
    isAxiosError: (e: unknown): boolean => Boolean((e as { isAxiosError?: boolean })?.isAxiosError),
  },
}));
vi.mock("node:fs/promises", () => ({
  default: { mkdir: vi.fn(), writeFile: vi.fn(), readFile: vi.fn().mockRejectedValue(new Error("no file")) },
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn().mockRejectedValue(new Error("no file")),
}));

import axios from "axios";
import { OpenReplayClient, AuthError, buildApiUrl, rangeFromHours } from "./openreplay.js";

const post = axios.post as unknown as Mock;
const request = axios.request as unknown as Mock;

function axiosError(status: number, data: unknown = "err") {
  return { isAxiosError: true, response: { status, statusText: "ERR", data } };
}

function loginOk(jwt = "jwt-123") {
  post.mockResolvedValueOnce({ data: { jwt, data: { user: { email: "a@b.com", name: "Tester" } } } });
}

beforeEach(() => {
  post.mockReset();
  request.mockReset();
});

describe("buildApiUrl", () => {
  it("prepends /api for bare self-hosted paths", () => {
    expect(buildApiUrl("https://or.example.com", "/projects")).toBe("https://or.example.com/api/projects");
  });
  it("keeps already-prefixed self-hosted paths", () => {
    expect(buildApiUrl("https://or.example.com/", "/api/login")).toBe("https://or.example.com/api/login");
    expect(buildApiUrl("https://or.example.com", "/1/sessions/search")).toBe(
      "https://or.example.com/api/1/sessions/search",
    );
  });
  it("strips /api and /v2/api for SaaS", () => {
    expect(buildApiUrl("https://app.openreplay.com", "/api/login")).toBe("https://api.openreplay.com/login");
    expect(buildApiUrl("https://app.openreplay.com", "/v2/api/1/cards/try")).toBe(
      "https://api.openreplay.com/v2/1/cards/try",
    );
  });
});

describe("rangeFromHours", () => {
  it("returns a second-rounded window of the requested width", () => {
    const r = rangeFromHours(24);
    expect(r.endTimestamp % 1000).toBe(0);
    expect(r.startTimestamp % 1000).toBe(0);
    expect(r.endTimestamp - r.startTimestamp).toBe(24 * 60 * 60 * 1000);
  });
});

describe("OpenReplayClient.login", () => {
  it("stores the JWT and returns the user", async () => {
    loginOk();
    const c = new OpenReplayClient({ appUrl: "https://or.example.com", email: "a@b.com", password: "pw" });
    const user = await c.login();
    expect(c.isAuthenticated()).toBe(true);
    expect(user).toEqual({ email: "a@b.com", name: "Tester" });
    expect(post).toHaveBeenCalledWith(
      "https://or.example.com/api/login",
      { email: "a@b.com", password: "pw" },
      expect.anything(),
    );
  });

  it("throws AuthError when no credentials are available", async () => {
    const c = new OpenReplayClient({ appUrl: "https://or.example.com" });
    await expect(c.login()).rejects.toBeInstanceOf(AuthError);
  });

  it("throws AuthError on bad credentials", async () => {
    post.mockRejectedValueOnce(axiosError(401, { errors: ["You've entered invalid Email or Password."] }));
    const c = new OpenReplayClient({ appUrl: "https://or.example.com", email: "a@b.com", password: "bad" });
    await expect(c.login()).rejects.toBeInstanceOf(AuthError);
  });
});

describe("OpenReplayClient.request", () => {
  it("auto-logs-in then sends a Bearer token", async () => {
    loginOk("tok");
    request.mockResolvedValueOnce({ data: { ok: true } });
    const c = new OpenReplayClient({ appUrl: "https://or.example.com", email: "a@b.com", password: "pw" });
    const out = await c.request("/projects");
    expect(out).toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://or.example.com/api/projects",
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
  });

  it("re-authenticates once on a 401 and retries", async () => {
    loginOk("old");
    const c = new OpenReplayClient({ appUrl: "https://or.example.com", email: "a@b.com", password: "pw" });
    await c.login();
    request.mockRejectedValueOnce(axiosError(401)).mockResolvedValueOnce({ data: { recovered: true } });
    loginOk("new");
    const out = await c.request("/projects");
    expect(out).toEqual({ recovered: true });
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("OpenReplayClient data methods", () => {
  it("listProjects maps projectId to string", async () => {
    loginOk();
    request.mockResolvedValueOnce({ data: { data: [{ projectId: 1, name: "p1" }] } });
    const c = new OpenReplayClient({ appUrl: "https://or.example.com", email: "a@b.com", password: "pw" });
    const projects = await c.listProjects();
    expect(projects).toEqual([{ projectId: "1", name: "p1" }]);
  });

  it("searchSessions posts a timestamped body and unwraps data", async () => {
    loginOk();
    request.mockResolvedValueOnce({ data: { data: { total: 2, sessions: [{ sessionId: "s1" }] } } });
    const c = new OpenReplayClient({ appUrl: "https://or.example.com", email: "a@b.com", password: "pw" });
    const res = await c.searchSessions("1", { startTimestamp: 100, endTimestamp: 200 }, { limit: 5 });
    expect(res.total).toBe(2);
    const callArg = request.mock.calls[0][0];
    expect(callArg.url).toBe("https://or.example.com/api/1/sessions/search");
    expect(callArg.method).toBe("POST");
    expect(callArg.data).toMatchObject({ startTimestamp: 100, endTimestamp: 200, limit: 5 });
  });

  it("normalizeFilter: wraps string value into array and infers name from type", async () => {
    loginOk();
    request.mockResolvedValueOnce({ data: { data: { total: 0, sessions: [] } } });
    const c = new OpenReplayClient({ appUrl: "https://or.example.com", email: "a@b.com", password: "pw" });
    await c.searchSessions(
      "1",
      { startTimestamp: 100, endTimestamp: 200 },
      { filters: [{ type: "userId", operator: "is", value: "some-uuid" }] },
    );
    const sent = request.mock.calls[0][0].data.filters[0];
    expect(sent.name).toBe("userId");
    expect(Array.isArray(sent.value)).toBe(true);
    expect(sent.value).toEqual(["some-uuid"]);
  });

  it("normalizeFilter: leaves array value and explicit name untouched", async () => {
    loginOk();
    request.mockResolvedValueOnce({ data: { data: { total: 0, sessions: [] } } });
    const c = new OpenReplayClient({ appUrl: "https://or.example.com", email: "a@b.com", password: "pw" });
    await c.searchSessions(
      "1",
      { startTimestamp: 100, endTimestamp: 200 },
      { filters: [{ type: "userBrowser", name: "myName", operator: "is", value: ["Chrome", "Firefox"] }] },
    );
    const sent = request.mock.calls[0][0].data.filters[0];
    expect(sent.name).toBe("myName");
    expect(sent.value).toEqual(["Chrome", "Firefox"]);
  });

  it("normalizeFilter: handles missing value with empty array", async () => {
    loginOk();
    request.mockResolvedValueOnce({ data: { data: { total: 0, sessions: [] } } });
    const c = new OpenReplayClient({ appUrl: "https://or.example.com", email: "a@b.com", password: "pw" });
    await c.searchSessions(
      "1",
      { startTimestamp: 100, endTimestamp: 200 },
      { filters: [{ type: "userId", operator: "isAny" }] },
    );
    const sent = request.mock.calls[0][0].data.filters[0];
    expect(sent.value).toEqual([]);
  });

  it("replayUrl embeds siteId, sessionId and the jwt", async () => {
    loginOk("zzz");
    const c = new OpenReplayClient({ appUrl: "https://or.example.com", email: "a@b.com", password: "pw" });
    await c.login();
    expect(c.replayUrl("1", "s9")).toBe("https://or.example.com/1/session/s9?jwt=zzz");
  });
});
