export class OwnerApiError extends Error {
  constructor(readonly status: number, readonly retryAfter?: number) {
    const message = status === 401 ? "Sign-in unsuccessful. Check your credentials and try again."
      : status === 403 ? "The owner security checks rejected this request."
        : status === 409 ? "The operation is already in progress. Try again."
          : status === 429 ? "Too many attempts. Wait for the cooldown before retrying."
            : status >= 500 ? "The owner service is temporarily unavailable."
              : "The request could not be completed.";
    super(message);
    this.name = "OwnerApiError";
  }
}

export async function ownerRequest<T>(
  url: string,
  options: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(method === "POST" ? { headers: { "Content-Type": "application/json", "X-VaultBridge-CSRF": "1" } } : {}),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error("Could not reach the local owner service.", { cause: error });
  }

  if (!response.ok) {
    const retryAfter = Number(response.headers.get("Retry-After"));
    throw new OwnerApiError(
      response.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 86_400) : undefined,
    );
  }
  if (response.status === 204) return undefined as T;
  try {
    return await response.json() as T;
  } catch {
    throw new Error("The owner service returned an invalid response.");
  }
}
