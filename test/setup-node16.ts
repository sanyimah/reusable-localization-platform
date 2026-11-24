import crypto from "node:crypto";
import fetch, { Headers, Request, Response } from "node-fetch";

if (!globalThis.crypto && crypto.webcrypto) {
  // @ts-ignore
  globalThis.crypto = crypto.webcrypto;
}
if (crypto.webcrypto?.getRandomValues && !(crypto as any).getRandomValues) {
  Object.defineProperty(crypto, "getRandomValues", {
    value: crypto.webcrypto.getRandomValues.bind(crypto.webcrypto),
    writable: true,
    configurable: true,
  });
}
if (!(globalThis as any).fetch) (globalThis as any).fetch = fetch as any;
if (!(globalThis as any).Headers) (globalThis as any).Headers = Headers as any;
if (!(globalThis as any).Request) (globalThis as any).Request = Request as any;
if (!(globalThis as any).Response) (globalThis as any).Response = Response as any;
