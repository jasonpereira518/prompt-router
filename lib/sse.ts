import { AppError } from "./errors";
// Decode UTF-8 and complete SSE frames, not arbitrary network chunks.
export async function* events(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader(),
    decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      if (pending.length > 2_000_000)
        throw new AppError(
          "Gateway sent an oversized stream event.",
          502,
          "malformed_stream",
        );
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, match.index);
        pending = pending.slice(match.index + match[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (data) yield data;
      }
      if (done) {
        if (pending.trim() && !pending.trim().startsWith(":"))
          throw new AppError(
            "Gateway stream ended inside an event.",
            502,
            "malformed_stream",
          );
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
