import "server-only";
import { requirePlatformCredentials } from "@/lib/platform/credentials";

/** A GET against this organization's Unipile workspace; the raw Response, checked for success. */
export async function unipileGet(path: string, init: { accept?: string } = {}): Promise<Response> {
  const { baseUrl, apiKey } = await requirePlatformCredentials("unipile");
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    headers: { "X-API-KEY": apiKey, accept: init.accept ?? "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Unipile answered ${response.status} to GET ${path}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  return response;
}

export async function unipileJson<T>(path: string): Promise<T> {
  return (await unipileGet(path)).json() as Promise<T>;
}
