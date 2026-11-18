import type { ApiAdapter, BatchOutcome, HttpApiConfig, HttpResponseLike } from "./types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const joinUrl = (base: string, p: string) => base.replace(/\/+$/, "") + "/" + p.replace(/^\/+/, "");

export function createHttpAdapter(cfg: HttpApiConfig): ApiAdapter {
  const retries = cfg.retries ?? 2;
  const delay = cfg.retryDelayMs ?? 500;
  const timeoutMs = cfg.timeoutMs ?? 15_000;

  const postPath = (appId: string) =>
    typeof cfg.postUrl === "function" ? cfg.postUrl(appId) : (cfg.postUrl ?? "/Generics/TranslationRequests");

  async function resolveHeaders(): Promise<Record<string, string>> {
    return typeof cfg.headers === "function" ? await cfg.headers() : (cfg.headers ?? {});
  }

  // GET: retry on network errors, 429 and 5xx.
  // POST: retry only on 429/502/503/504 - never on timeouts, since the server may have processed it.
  async function send(method: "GET" | "POST", url: string, body?: unknown): Promise<HttpResponseLike> {
    const headers = await resolveHeaders();
    const retryStatus = (s: number) => (method === "GET" ? s === 429 || s >= 500 : [429, 502, 503, 504].includes(s));

    for (let attempt = 0; ; attempt++) {
      const last = attempt >= retries;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method,
          headers: {
            Accept: "application/json",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...headers,
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: ctrl.signal,
        });
        const text = await res.text();
        let parsed: unknown = text;
        try {
          parsed = text ? JSON.parse(text) : undefined;
        } catch {
          /* keep raw text */
        }
        if (retryStatus(res.status) && !last) {
          await sleep(delay * 2 ** attempt);
          continue;
        }
        return { status: res.status, body: parsed };
      } catch (err) {
        if (method === "GET" && !last) {
          await sleep(delay * 2 ** attempt);
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  const isSuccess = cfg.isSuccess ?? ((r: HttpResponseLike) => r.status >= 200 && r.status < 300);
  const isDuplicate = cfg.isDuplicate ?? ((r: HttpResponseLike) => r.status === 409);

  return {
    batchSize: cfg.batchSize ?? 1,
    concurrency: cfg.concurrency ?? 3,

    async fetchExisting(appId) {
      const p = cfg.getUrl ? cfg.getUrl(appId) : `/api/GetTranslations/${appId}`;
      const res = await send("GET", joinUrl(cfg.baseUrl, p));
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`GET ${p} failed with HTTP ${res.status}: ${snippet(res.body)}`);
      }
      const keys = cfg.parseExisting(res.body);
      if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string")) {
        throw new Error("parseExisting() must return string[] (a flat list of existing keys).");
      }
      return keys;
    },

    async register(keys, appId): Promise<BatchOutcome> {
      try {
        const res = await send("POST", joinUrl(cfg.baseUrl, postPath(appId)), cfg.buildPayload(keys, appId));
        if (isDuplicate(res)) return { status: "duplicate" };
        if (isSuccess(res)) return { status: "registered" };
        return { status: "failed", error: `HTTP ${res.status}: ${snippet(res.body)}`, httpStatus: res.status };
      } catch (err) {
        return { status: "failed", error: err instanceof Error ? err.message : String(err) };
      }
    },

    previewPayload: (keys, appId) => cfg.buildPayload(keys, appId),
  };
}

function snippet(body: unknown): string {
  const s = typeof body === "string" ? body : JSON.stringify(body);
  return (s ?? "").slice(0, 200);
}