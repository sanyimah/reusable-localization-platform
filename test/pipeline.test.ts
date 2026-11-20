import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/config.js";
import { diffKeys } from "../src/differ.js";
import { createHttpAdapter } from "../src/http-adapter.js";
import { registerKeys } from "../src/registrar.js";
import { scanProject } from "../src/scanner.js";
import type { ApiAdapter } from "../src/types.js";

describe("differ", () => {
  it("splits discovered keys into existing and missing (case-sensitive)", () => {
    const r = diffKeys(["Save", "Cancel", "save", "Save"], ["Save"]);
    expect(r.existing).toEqual(["Save"]);
    expect(r.missing).toEqual(["Cancel", "save"]);
  });
});

describe("registrar", () => {
  const fake = (overrides: Partial<ApiAdapter> = {}) => {
    const calls: string[][] = [];
    const adapter: ApiAdapter = {
      batchSize: 2,
      concurrency: 2,
      fetchExisting: async () => [],
      register: async (keys) => {
        calls.push(keys);
        return { status: "registered" };
      },
      ...overrides,
    };
    return { adapter, calls };
  };

  it("makes zero calls in dry-run mode", async () => {
    const { adapter, calls } = fake();
    const s = await registerKeys(adapter, "app", ["a", "b", "c"], { apply: false });
    expect(calls).toHaveLength(0);
    expect(s.planned).toEqual(["a", "b", "c"]);
  });

  it("batches keys", async () => {
    const { adapter, calls } = fake();
    const s = await registerKeys(adapter, "app", ["a", "b", "c"], { apply: true });
    expect(calls).toHaveLength(2);
    expect(s.registered.sort()).toEqual(["a", "b", "c"]);
  });

  it("respects --limit", async () => {
    const { adapter } = fake({ batchSize: 1 });
    const s = await registerKeys(adapter, "app", ["a", "b", "c"], { apply: true, limit: 1 });
    expect(s.registered).toEqual(["a"]);
    expect(s.skippedByLimit).toEqual(["b", "c"]);
  });

  it("keeps going after a failed batch", async () => {
    const { adapter } = fake({
      batchSize: 1,
      register: async (keys) => (keys[0] === "b" ? { status: "failed", error: "boom" } : { status: "registered" }),
    });
    const s = await registerKeys(adapter, "app", ["a", "b", "c"], { apply: true });
    expect(s.registered.sort()).toEqual(["a", "c"]);
    expect(s.failed).toEqual([{ key: "b", error: "boom" }]);
  });

  it("counts duplicates separately", async () => {
    const { adapter } = fake({ batchSize: 1, register: async () => ({ status: "duplicate" }) });
    const s = await registerKeys(adapter, "app", ["a"], { apply: true });
    expect(s.duplicates).toEqual(["a"]);
  });

  it("turns a thrown error into a failure", async () => {
    const { adapter } = fake({
      batchSize: 1,
      register: async () => {
        throw new Error("network down");
      },
    });
    const s = await registerKeys(adapter, "app", ["a"], { apply: true });
    expect(s.failed[0].error).toBe("network down");
  });
});

describe("http adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  const baseCfg = {
    baseUrl: "https://example.test",
    retryDelayMs: 1,
    parseExisting: (b: unknown) => (b as { keys: string[] }).keys,
    buildPayload: (keys: string[], appId: string) => ({ appId, keys }),
  };

  it("scans source, compares with GET, and posts only missing keys on apply", async () => {
    const url = "https://example.test";
    const getUrl = url + "/api/GetTranslations/demo%2Fapp";
    const postUrl = url + "/Generics/TranslationRequests";
    const scan = await scanProject(resolveConfig({
      appId: "demo/app",
      include: ["demo/src/App.tsx"],
    }, process.cwd()));
    const discovered = [...scan.keys.keys()].sort();
    expect(discovered.length).toBeGreaterThan(1);
    const [existing, ...missing] = discovered;
    const database = new Set([existing]);
    const fetchMock = vi.fn(async (requestUrl: string, init: RequestInit) => {
      if (init.method === "GET" && requestUrl === getUrl) {
        return Response.json({ keys: [...database] });
      }
      if (init.method === "POST" && requestUrl === postUrl) {
        const payload = JSON.parse(init.body as string);
        expect(payload.appId).toBe("demo/app");
        expect(payload.keys).toEqual(missing);
        payload.keys.forEach((key: string) => database.add(key));
        return new Response(null, { status: 201 });
      }
      throw new Error(`Unexpected request: ${init.method} ${requestUrl}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createHttpAdapter({ ...baseCfg, batchSize: discovered.length });

    const diff = diffKeys(scan.keys.keys(), await adapter.fetchExisting("demo/app"));
    expect(diff).toEqual({ existing: [existing], missing });
    const dryRun = await registerKeys(adapter, "demo/app", diff.missing, { apply: false });
    expect(dryRun.planned).toEqual(missing);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const applied = await registerKeys(adapter, "demo/app", diff.missing, { apply: true });
    expect(applied.registered).toEqual(missing);
    const next = diffKeys(scan.keys.keys(), await adapter.fetchExisting("demo/app"));
    expect(next.missing).toEqual([]);
  });

  it("rejects an undefined POST body before sending the request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createHttpAdapter({ ...baseCfg, buildPayload: () => undefined });
    await expect(adapter.register(["A"], "app1")).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("buildPayload()"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches and parses existing keys", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ keys: ["A", "B"] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createHttpAdapter(baseCfg);
    expect(await adapter.fetchExisting("app1")).toEqual(["A", "B"]);
    expect(fetchMock.mock.calls[0][0]).toBe("https://example.test/api/GetTranslations/app1");
  });

  it("throws if parseExisting returns the wrong shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ keys: [1, 2] }), { status: 200 })));
    const adapter = createHttpAdapter(baseCfg);
    await expect(adapter.fetchExisting("app1")).rejects.toThrow("string[]");
  });

  it("treats 409 as duplicate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("exists", { status: 409 })));
    const adapter = createHttpAdapter(baseCfg);
    expect(await adapter.register(["A"], "app1")).toEqual({ status: "duplicate" });
  });

  it("retries a POST on 503 then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createHttpAdapter(baseCfg);
    expect(await adapter.register(["A"], "app1")).toEqual({ status: "registered" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a POST on 500", async () => {
    const fetchMock = vi.fn(async () => new Response("err", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createHttpAdapter(baseCfg);
    const r = await adapter.register(["A"], "app1");
    expect(r.status).toBe("failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends the payload built by buildPayload", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createHttpAdapter(baseCfg);
    await adapter.register(["A", "B"], "app1");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ appId: "app1", keys: ["A", "B"] });
  });
});
