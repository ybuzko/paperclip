import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export type JsonHttpResponse = { status: number; text: string };

/**
 * POST a JSON body over node:http(s) instead of the global fetch.
 *
 * Node's fetch (undici) fails any request whose response headers take longer than 300 s with
 * UND_ERR_HEADERS_TIMEOUT, regardless of the caller's AbortSignal. A blocking claudeclaw inject
 * holds the response until the supervisor's turn finishes, which routinely takes longer than that.
 * node:http applies no header or body timeout unless one is configured, so only `signal` bounds
 * this call.
 */
export function postJson(
  url: URL,
  input: { headers: Record<string, string>; body: string; signal?: AbortSignal },
): Promise<JsonHttpResponse> {
  return new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(
      url,
      {
        method: "POST",
        headers: { ...input.headers, "Content-Length": String(Buffer.byteLength(input.body)) },
        ...(input.signal ? { signal: input.signal } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(input.body);
  });
}
