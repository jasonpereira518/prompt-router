import { checkpoint, detail, beginGeneration, settings } from "./db";
import {
  catalog,
  prepareInference,
  inference,
  eligibleModels,
  GATEWAY_VERSION,
} from "./gateway";
import { attachmentContent, MAX_FILES } from "./files";
import { events } from "./sse";
import { AppError, publicError } from "./errors";
import type { Attachment, Generation, Message } from "./types";
const state = globalThis as typeof globalThis & {
  omniActive?: Map<string, AbortController>;
};
const active = (state.omniActive ||= new Map());
export function stop(id: string) {
  const controller = active.get(id);
  if (!controller)
    throw new AppError("This response is no longer active.", 409);
  controller.abort("stopped");
}
export function usableHistory(messages: Message[], generations: Generation[]) {
  const finished = new Map(
    generations
      .filter((g) => g.status !== "pending")
      .map((g) => [g.id, g.status]),
  );
  const result: Message[] = [];
  let answer: Message | undefined;
  for (const message of messages) {
    if (message.role === "user") {
      if (answer) result.push(answer);
      answer = undefined;
      result.push(message);
    } else if (message.generationId && finished.has(message.generationId)) {
      const status = finished.get(message.generationId);
      answer =
        status === "completed"
          ? message
          : {
              ...message,
              content: `${message.content}\n[This answer is partial: ${status}.]`,
            };
    }
  }
  if (answer) result.push(answer);
  return result;
}
export function estimateContext(
  messages: Message[],
  attachments: Attachment[],
  output: number,
) {
  let bytes = 1024 + output;
  for (const m of messages) {
    bytes += Buffer.byteLength(m.content, "utf8") + 32;
    for (const id of m.attachmentIds) {
      const a = attachments.find((a) => a.id === id);
      if (!a)
        throw new AppError(
          "An attachment is missing. Remove it before sending.",
        );
      bytes += a.type.startsWith("image/")
        ? 32768
        : Buffer.byteLength(a.text || "", "utf8") + 256;
    }
  }
  return bytes;
}
export async function startChat(input: {
  conversationId: string;
  content: string;
  attachmentIds: string[];
  retryId?: string;
  excludeMessageIds: string[];
}) {
  const c = detail(input.conversationId),
    s = settings();
  const retry = input.retryId
    ? c.messages.find((m) => m.id === input.retryId && m.role === "user")
    : undefined;
  if (input.retryId && !retry) throw new AppError("Prompt not found.", 404);
  const newest = c.messages.filter((m) => m.role === "user").at(-1);
  if (retry && newest?.id !== retry.id)
    throw new AppError("Only the latest prompt can be retried.");
  const content = retry?.content ?? input.content,
    attachmentIds = retry?.attachmentIds ?? input.attachmentIds;
  if (!content.trim() && !attachmentIds.length)
    throw new AppError("Write a message or add an attachment.");
  if (attachmentIds.length > MAX_FILES)
    throw new AppError("Attach at most six files to one message.");
  for (const id of attachmentIds) {
    const a = c.attachments.find((a) => a.id === id);
    if (!a || a.status !== "ready")
      throw new AppError(
        "An attachment is missing or unreadable. Remove it before sending.",
      );
  }
  if (
    input.excludeMessageIds.some((id) => !c.messages.some((m) => m.id === id))
  )
    throw new AppError("Context selection includes an unknown message.");
  const all = usableHistory(
    retry ? c.messages.slice(0, c.messages.indexOf(retry)) : c.messages,
    c.generations,
  );
  for (let i = 0; i < all.length; i++)
    if (all[i].role === "user" && input.excludeMessageIds.includes(all[i].id))
      for (let j = i + 1; j < all.length && all[j].role !== "user"; j++)
        if (!input.excludeMessageIds.includes(all[j].id))
          throw new AppError("Exclude a complete turn, including its answer.");
  const history = all.filter((m) => !input.excludeMessageIds.includes(m.id));
  const pending: Message = retry || {
    id: "next",
    conversationId: c.id,
    role: "user",
    content,
    createdAt: "",
    generationId: null,
    attachmentIds,
  };
  const messages = [...history, pending];
  const vision = messages.some((m) =>
    m.attachmentIds.some((id) =>
      c.attachments.find((a) => a.id === id)?.type.startsWith("image/"),
    ),
  );
  const cat = await catalog(),
    eligible = eligibleModels(cat, s, c.route, vision);
  const context = Math.min(...eligible.models.map((m) => m.context!)),
    output = c.outputCap;
  if (eligible.models.some((m) => m.maxOutput && output > m.maxOutput))
    throw new AppError(
      "Output limit exceeds a selected model's supported maximum. Lower it in chat settings.",
      422,
    );
  if (estimateContext(messages, c.attachments, output) > context)
    throw new AppError(
      "This chat exceeds the conservative context budget. Choose older messages to exclude in Context, or select models with larger verified limits.",
      422,
      "context_limit",
    );
  // Fully assemble attachments before committing an attempt, so preflight failures do not create empty attempts.
  const wire = await Promise.all(
    messages.map(async (m) => ({
      role: m.role,
      content: m.attachmentIds.length
        ? [
            { type: "text", text: m.content },
            ...(await Promise.all(
              m.attachmentIds.map((id) =>
                attachmentContent(c.attachments.find((a) => a.id === id)!),
              ),
            )),
          ]
        : m.content,
    })),
  );
  if (JSON.stringify(settings()) !== JSON.stringify(s))
    throw new AppError(
      "Routing settings changed during preparation. Send again with the current settings.",
      409,
    );
  const current = detail(c.id);
  if (
    current.route !== c.route ||
    current.outputCap !== c.outputCap ||
    current.messages.length !== c.messages.length
  )
    throw new AppError(
      "This conversation changed on another device. Refresh before sending.",
      409,
    );
  const id = beginGeneration(
      c.id,
      c.route,
      content,
      attachmentIds,
      input.retryId,
      input.excludeMessageIds,
    ),
    controller = new AbortController();
  active.set(id, controller);
  const encoder = new TextEncoder();
  let outputText = "",
    cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(sink) {
      const emit = (type: string, data: unknown) => {
        if (!cancelled) {
          try {
            sink.enqueue(
              encoder.encode(
                `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`,
              ),
            );
          } catch {
            cancelled = true;
          }
        }
      };
      emit("attempt", { id });
      void (async () => {
        let cleanup: (() => Promise<void>) | undefined;
        const began = Date.now();
        const timeout = setTimeout(() => controller.abort("timeout"), 600000);
        const patch: Partial<Generation> = {};
        let complete = false,
          lastCheckpoint = 0;
        try {
          const prepared = await prepareInference(
            cat,
            s,
            c.route,
            vision,
            controller.signal,
          );
          cleanup = prepared.cleanup;
          const outputParameter = prepared.models.some((m) =>
            m.unsupportedParams.includes("max_tokens"),
          )
            ? "max_completion_tokens"
            : "max_tokens";
          const upstream = await inference(
            {
              model: prepared.comboName,
              messages: wire,
              stream: true,
              stream_options: { include_usage: true },
              [outputParameter]: output,
            },
            prepared.key,
            controller.signal,
          );
          const version = upstream.headers.get("x-omniroute-version");
          if (version && version !== GATEWAY_VERSION)
            throw new AppError(
              "Gateway version changed. Restore the pinned version before chatting.",
              502,
              "incompatible_gateway",
            );
          if (!upstream.body)
            throw new AppError(
              "Gateway response did not contain a stream.",
              502,
            );
          const reportedCost = Number(
            upstream.headers.get("x-omniroute-response-cost"),
          );
          if (Number.isFinite(reportedCost) && reportedCost > 0)
            patch.cost = reportedCost;
          const decision = upstream.headers.get("x-omniroute-decision");
          const reportedProvider = decision?.match(
            /(?:^|;\s*)provider=([^;]+)/,
          )?.[1];
          if (reportedProvider) patch.provider = reportedProvider;
          patch.fallback = upstream.headers.get(
            "x-omniroute-fallback-attempts",
          );
          patch.resolvedModel = upstream.headers.get("x-omniroute-model");
          patch.provider =
            upstream.headers.get("x-omniroute-provider") ||
            patch.provider ||
            null;
          for await (const event of events(upstream.body)) {
            if (event === "[DONE]") {
              complete = true;
              break;
            }
            let data;
            try {
              data = JSON.parse(event);
            } catch {
              throw new AppError(
                "Gateway sent malformed stream data.",
                502,
                "malformed_stream",
              );
            }
            if (data.error)
              throw new AppError(
                "Provider failed during generation. Partial output has been saved.",
                502,
                "provider_failure",
              );
            const choice = data.choices?.[0];
            const delta = choice?.delta?.content;
            if (typeof delta === "string") {
              outputText += delta;
              if (outputText.length > 2_000_000)
                throw new AppError("Response exceeded the storage limit.", 413);
              emit("delta", { text: delta });
            }
            if (
              typeof data.model === "string" &&
              data.model !== prepared.comboName
            )
              patch.resolvedModel = data.model;
            if (typeof data.provider === "string")
              patch.provider = data.provider;
            if (data.usage) {
              if (
                Number.isInteger(data.usage.prompt_tokens) &&
                data.usage.prompt_tokens >= 0
              )
                patch.inputTokens = data.usage.prompt_tokens;
              if (
                Number.isInteger(data.usage.completion_tokens) &&
                data.usage.completion_tokens >= 0
              )
                patch.outputTokens = data.usage.completion_tokens;
            }
            if (choice?.finish_reason && choice.finish_reason !== "error")
              complete = true;
            if (Date.now() - lastCheckpoint > 250) {
              checkpoint(id, outputText, patch);
              lastCheckpoint = Date.now();
            }
          }
          if (!complete)
            throw new AppError(
              "Gateway closed before confirming completion. Partial output was saved.",
              502,
              "incomplete_stream",
            );
          if (controller.signal.aborted)
            throw new AppError("Generation stopped.");
          const status = "completed";
          checkpoint(id, outputText, {
            ...patch,
            status,
            latency: Date.now() - began,
          });
          emit("done", { id, status });
        } catch (error) {
          const status = controller.signal.aborted
            ? controller.signal.reason === "stopped"
              ? "stopped"
              : controller.signal.reason === "disconnect"
                ? "interrupted"
                : "failed"
            : "failed";
          const message =
            controller.signal.reason === "timeout"
              ? "Response timed out. Partial output was saved."
              : controller.signal.reason === "disconnect"
                ? "Browser disconnected. Partial output was saved."
                : controller.signal.reason === "stopped"
                  ? null
                  : publicError(error).error;
          checkpoint(id, outputText, {
            ...patch,
            status,
            error: message,
            latency: Date.now() - began,
          });
          emit("done", { id, status, error: message });
        } finally {
          clearTimeout(timeout);
          active.delete(id);
          if (!cancelled) {
            try {
              sink.close();
            } catch {
              // The reader may already have closed the response stream.
            }
          }
          if (cleanup) await cleanup();
        }
      })();
    },
    cancel() {
      cancelled = true;
      controller.abort("disconnect");
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
