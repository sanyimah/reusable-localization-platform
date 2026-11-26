import crypto from 'node:crypto';
import fetch, { Headers, Request, Response } from 'node-fetch';

if (!globalThis.crypto && crypto.webcrypto) {
  globalThis.crypto = crypto.webcrypto;
}
if (crypto.webcrypto?.getRandomValues && !crypto.getRandomValues) {
  Object.defineProperty(crypto, 'getRandomValues', {
    value: crypto.webcrypto.getRandomValues.bind(crypto.webcrypto),
    writable: true,
    configurable: true,
  });
}
if (!globalThis.fetch) globalThis.fetch = fetch;
if (!globalThis.Headers) globalThis.Headers = Headers;
if (!globalThis.Request) globalThis.Request = Request;
if (!globalThis.Response) globalThis.Response = Response;

process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(2)];
await import('../node_modules/vitest/dist/cli.js');
