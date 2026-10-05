export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const r = await fetch(`/api/${path}`, {
    ...options,
    headers:
      options.body instanceof FormData
        ? options.headers
        : { "Content-Type": "application/json", ...options.headers },
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "The request failed. Try again.");
  return data;
}
export const write = (method: string, value?: unknown) => ({
  method,
  body: value === undefined ? undefined : JSON.stringify(value),
});
