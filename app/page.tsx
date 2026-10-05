"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Download,
  LogOut,
  Menu,
  MessageSquare,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { api, write } from "@/lib/client";
import {
  defaults,
  presets,
  type Catalog,
  type Conversation,
  type ConversationDetail,
  type Settings,
  type Generation,
  type Message,
} from "@/lib/types";
import { events } from "@/lib/sse";
import { MarkdownText } from "@/components/markdown";
import { SettingsView } from "@/components/settings";
const routeLabels: Record<string, string> = {
  balanced: "Balanced",
  quality: "Quality",
  fast: "Fast",
  economy: "Economy",
};
function Logo() {
  return (
    <span className="logo" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}
function ErrorBanner({
  error,
  onClose,
}: {
  error: string;
  onClose: () => void;
}) {
  return error ? (
    <div className="alert" role="alert">
      {error}
      <button aria-label="Dismiss error" onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  ) : null;
}
function Login({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <main className="login">
      <div className="login-intro">
        <Logo />
        <h1>
          All your models.
          <br />
          One conversation.
        </h1>
        <p>Welcome to Omni, your private space to think, write, and build.</p>
        <div className="login-detail">
          <span>Thoughtful routing</span>
          <span>Shared history</span>
          <span>Your connections</span>
        </div>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api("session", write("POST", { email, password }));
            setPassword("");
            onLogin();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2>Sign in to Omni</h2>
        <p>Access is reserved for the configured owner.</p>
        <label>
          Email
          <input
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
          <ArrowUp size={16} />
        </button>
      </form>
    </main>
  );
}
function Usage({ g }: { g?: Generation }) {
  return (
    <span className="usage">
      {g?.inputTokens != null
        ? `${g.inputTokens.toLocaleString()} in`
        : "Input unavailable"}
      <span>·</span>
      {g?.outputTokens != null
        ? `${g.outputTokens.toLocaleString()} out`
        : "Output unavailable"}
      {g?.latency != null && (
        <>
          <span>·</span>
          {(g.latency / 1000).toFixed(1)}s
        </>
      )}
      {g?.cost != null && (
        <>
          <span>·</span>~${g.cost.toFixed(4)}
        </>
      )}
    </span>
  );
}
export default function Home() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null),
    [list, setList] = useState<Conversation[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [chat, setChat] = useState<ConversationDetail | null>(null),
    [settings, setSettings] = useState<Settings>(defaults),
    [catalog, setCatalog] = useState<Catalog | null>(null),
    [search, setSearch] = useState(""),
    [screen, setScreen] = useState("chat"),
    [error, setError] = useState(""),
    [draft, setDraft] = useState(""),
    [sending, setSending] = useState(false),
    [liveText, setLiveText] = useState(""),
    [optimistic, setOptimistic] = useState(""),
    [attempt, setAttempt] = useState<string | null>(null),
    [queued, setQueued] = useState<
      { id: string; name: string; status: string; error: string | null }[]
    >([]),
    [uploading, setUploading] = useState(false),
    [sidebar, setSidebar] = useState(false),
    [contextOpen, setContextOpen] = useState(false),
    [excluded, setExcluded] = useState<string[]>([]),
    [copied, setCopied] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null),
    bottom = useRef<HTMLDivElement>(null),
    scrollRef = useRef<HTMLDivElement>(null),
    draftRef = useRef<HTMLTextAreaElement>(null),
    nearBottom = useRef(true),
    generationRef = useRef<string | null>(null);
  const refreshList = useCallback(async () => {
    setList(
      await api<Conversation[]>(
        `conversations?search=${encodeURIComponent(search)}`,
      ),
    );
  }, [search]);
  const refreshCatalog = useCallback(async () => {
    try {
      setCatalog(await api<Catalog>("catalog"));
    } catch (e) {
      setCatalog(null);
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void api<{ authenticated: boolean }>("session")
      .then((r) => setAuthenticated(r.authenticated))
      .catch((e) => setError((e as Error).message));
  }, []);
  useEffect(() => {
    if (authenticated) {
      void api<Conversation[]>(
        `conversations?search=${encodeURIComponent(search)}`,
      )
        .then(setList)
        .catch((e) => setError(e.message));
      void api<Settings>("settings")
        .then(setSettings)
        .catch((e) => setError(e.message));
      void api<Catalog>("catalog")
        .then(setCatalog)
        .catch((e) => setError(e.message));
    }
  }, [authenticated, search]);
  useEffect(() => {
    if (!selected || !authenticated) return;
    let current = true;
    const load = () =>
      api<ConversationDetail>(`conversations/${selected}`)
        .then((c) => {
          if (current) setChat(c);
        })
        .catch((e) => {
          if (current) setError(e.message);
        });
    if (!sending) void load();
    const timer = setInterval(() => {
      if (!sending) void load();
    }, 3000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [selected, authenticated, sending]);
  useEffect(() => {
    if (!authenticated) return;
    const timer = setInterval(() => {
      void api<Conversation[]>(
        `conversations?search=${encodeURIComponent(search)}`,
      )
        .then(setList)
        .catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [authenticated, search]);
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);
  useEffect(() => {
    if (nearBottom.current)
      bottom.current?.scrollIntoView({ behavior: "instant" });
  }, [liveText, chat?.messages.length]);
  async function ensureChat() {
    if (selected) return selected;
    const c = await api<Conversation>("conversations", write("POST", {}));
    setSelected(c.id);
    setChat({ ...c, messages: [], generations: [], attachments: [] });
    await refreshList();
    return c.id;
  }
  function newChat() {
    if (sending) return;
    setSelected(null);
    setChat(null);
    setDraft("");
    setQueued([]);
    setExcluded([]);
    setSidebar(false);
    setScreen("chat");
    draftRef.current?.focus();
  }
  async function change(patch: Partial<Conversation>) {
    try {
      const id = await ensureChat();
      setChat(
        await api<ConversationDetail>(
          `conversations/${id}`,
          write("PATCH", patch),
        ),
      );
      await refreshList();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function send(retryId?: string) {
    if (sending || uploading) return;
    const pending = chat?.generations.find((g) => g.status === "pending");
    if (pending) {
      setError("A response is already running in this conversation.");
      return;
    }
    setSending(true);
    setError("");
    setLiveText("");
    const text = retryId
      ? chat?.messages.find((m) => m.id === retryId)?.content || ""
      : draft;
    setOptimistic(retryId ? "" : text);
    generationRef.current = null;
    try {
      if (queued.some((a) => a.status !== "ready"))
        throw new Error("Remove unreadable attachments before sending.");
      const id = await ensureChat();
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: id,
          content: text,
          attachmentIds: queued.map((a) => a.id),
          retryId,
          excludeMessageIds: excluded,
        }),
      });
      if (!r.ok) {
        const e = await r.json();
        throw new Error(e.error);
      }
      if (!r.body) throw new Error("The response stream was not available.");
      setDraft("");
      setQueued([]);
      for await (const raw of events(r.body)) {
        const data = JSON.parse(raw);
        if (data.id && !data.status) {
          setAttempt(data.id);
          generationRef.current = data.id;
        }
        if (typeof data.text === "string") setLiveText((t) => t + data.text);
        if (data.error) setError(data.error);
      }
      setChat(await api<ConversationDetail>(`conversations/${id}`));
      await refreshList();
    } catch (e) {
      setError((e as Error).message);
      if (selected)
        try {
          setChat(await api<ConversationDetail>(`conversations/${selected}`));
        } catch {
          // Keep the original error visible if recovery refresh also fails.
        }
    } finally {
      setSending(false);
      setAttempt(null);
      setOptimistic("");
      setLiveText("");
      generationRef.current = null;
    }
  }
  async function stopResponse() {
    const id =
      attempt || chat?.generations.find((g) => g.status === "pending")?.id;
    if (id)
      try {
        await api(`generations/${id}/stop`, write("POST", {}));
      } catch (e) {
        setError((e as Error).message);
      }
  }
  async function attach(files: FileList | null) {
    if (!files) return;
    setUploading(true);
    setError("");
    try {
      if (files.length + queued.length > 6)
        throw new Error("Attach at most six files to one message.");
      const id = await ensureChat();
      for (const file of Array.from(files)) {
        const data = new FormData();
        data.append("file", file);
        const a = await api<{
          id: string;
          name: string;
          status: string;
          error: string | null;
        }>(`conversations/${id}/attachments`, { method: "POST", body: data });
        setQueued((old) => [...old, a]);
      }
      setChat(await api<ConversationDetail>(`conversations/${id}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }
  const active =
      sending || chat?.generations.some((g) => g.status === "pending"),
    route = chat?.route || "balanced";
  async function copy(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setError("Clipboard access was denied. Select the text to copy it.");
    }
  }
  if (authenticated === null)
    return (
      <main className="loading-screen">
        <Logo />
        <p>{error || "Opening your workspace…"}</p>
      </main>
    );
  if (!authenticated) return <Login onLogin={() => setAuthenticated(true)} />;
  return (
    <main className="workspace">
      <aside className={`sidebar ${sidebar ? "open" : ""}`}>
        <Link className="brand" href="/" aria-label="Omni home">
          <Logo />
          <span>Omni</span>
        </Link>
        <button
          className="sidebar-close icon-button"
          aria-label="Close conversation history"
          onClick={() => setSidebar(false)}
        >
          <X size={18} />
        </button>
        <button
          className="new-chat"
          disabled={Boolean(active)}
          onClick={newChat}
        >
          <Plus size={18} />
          New conversation
        </button>
        <label className="search">
          <Search size={15} />
          <input
            aria-label="Search conversations"
            placeholder="Search history"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="history-title">
          Conversations<span>{list.length}</span>
        </div>
        <nav className="history" aria-label="Conversation history">
          {list.map((c) => (
            <button
              key={c.id}
              className={selected === c.id ? "selected" : ""}
              disabled={sending}
              onClick={() => {
                setSelected(c.id);
                setQueued([]);
                setExcluded([]);
                setSidebar(false);
                setScreen("chat");
              }}
            >
              <MessageSquare size={15} />
              <span>{c.title}</span>
            </button>
          ))}
          {!list.length && (
            <p className="history-empty">
              {search
                ? "No matching conversations."
                : "Your conversations will appear here."}
            </p>
          )}
        </nav>
        <div className="sidebar-footer">
          <button
            onClick={() => {
              setScreen("settings");
              setSidebar(false);
            }}
          >
            <Settings2 size={17} />
            Settings
            <span
              className={
                catalog ? "connection-dot connected" : "connection-dot"
              }
            />
          </button>
          <button
            onClick={async () => {
              try {
                await api("session", write("DELETE"));
                setAuthenticated(false);
                setChat(null);
                setList([]);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <LogOut size={17} />
            Sign out
          </button>
          <small>Private workspace · OmniRoute</small>
        </div>
      </aside>
      <section className="main-panel">
        {screen === "settings" ? (
          <SettingsView
            settings={settings}
            catalog={catalog}
            onSave={setSettings}
            onBack={() => setScreen("chat")}
            onRefresh={refreshCatalog}
          />
        ) : (
          <>
            <header className="chat-header">
              <button
                className="icon-button mobile-menu"
                aria-label="Open conversation history"
                onClick={() => setSidebar(!sidebar)}
              >
                <Menu size={20} />
              </button>
              <div className="route-control">
                <select
                  aria-label="Model or routing preset"
                  value={route}
                  disabled={Boolean(active)}
                  onChange={(e) => change({ route: e.target.value })}
                >
                  {presets.map((p) => (
                    <option key={p} value={p}>
                      {routeLabels[p]}
                      {!settings.routes[p].length ? " · Set up" : ""}
                    </option>
                  ))}
                  {catalog?.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </div>
              <span className="gateway-state">
                <span
                  className={
                    catalog ? "connection-dot connected" : "connection-dot"
                  }
                />
                {catalog ? "Gateway connected" : "Gateway unavailable"}
              </span>
              <div className="header-actions">
                {chat && (
                  <>
                    <button
                      className="icon-button"
                      aria-label="Rename conversation"
                      onClick={() => {
                        const title = prompt("Conversation name", chat.title);
                        if (title?.trim()) void change({ title: title.trim() });
                      }}
                    >
                      <Pencil size={16} />
                    </button>
                    <a
                      className="icon-button"
                      aria-label="Export as Markdown"
                      href={`/api/conversations/${chat.id}/export?format=md`}
                    >
                      <Download size={16} />
                    </a>
                    <button
                      className="icon-button"
                      disabled={Boolean(active)}
                      aria-label="Delete conversation"
                      onClick={async () => {
                        if (
                          !confirm(
                            "Delete this conversation and its attachments?",
                          )
                        )
                          return;
                        try {
                          await api(
                            `conversations/${chat.id}`,
                            write("DELETE"),
                          );
                          newChat();
                          await refreshList();
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </>
                )}
              </div>
            </header>
            <ErrorBanner error={error} onClose={() => setError("")} />
            <div
              className="transcript"
              ref={scrollRef}
              onScroll={() => {
                const e = scrollRef.current;
                if (e)
                  nearBottom.current =
                    e.scrollHeight - e.scrollTop - e.clientHeight < 120;
              }}
            >
              <div className="transcript-inner">
                {chat && chat.generations.length > 0 && (
                  <details className="conversation-usage">
                    <summary>
                      Conversation usage · {chat.generations.length} attempt
                      {chat.generations.length === 1 ? "" : "s"}
                    </summary>
                    <p>
                      Input tokens:{" "}
                      {chat.generations.every((g) => g.inputTokens !== null)
                        ? chat.generations
                            .reduce((n, g) => n + g.inputTokens!, 0)
                            .toLocaleString()
                        : "Unavailable (one or more attempts did not report usage)"}
                    </p>
                    <p>
                      Output tokens:{" "}
                      {chat.generations.every((g) => g.outputTokens !== null)
                        ? chat.generations
                            .reduce((n, g) => n + g.outputTokens!, 0)
                            .toLocaleString()
                        : "Unavailable (one or more attempts did not report usage)"}
                    </p>
                    <p>
                      Estimated API cost:{" "}
                      {chat.generations.every((g) => g.cost !== null)
                        ? `~$${chat.generations.reduce((n, g) => n + g.cost!, 0).toFixed(4)}`
                        : "Unavailable"}
                    </p>
                  </details>
                )}

                {!chat?.messages.length && !sending ? (
                  <div className="welcome">
                    <Logo />
                    <h1>What’s on your mind?</h1>
                    <p>
                      Bring an idea, a question, or a file.
                      <br />
                      Omni finds a route through your connected models.
                    </p>
                    <div className="route-note">
                      <span>{routeLabels[route] || "Direct model"}</span>
                      {settings.routes[route as (typeof presets)[number]]
                        ?.length ? (
                        <p>
                          Ready with{" "}
                          {
                            settings.routes[route as (typeof presets)[number]]
                              .length
                          }{" "}
                          selected models.
                        </p>
                      ) : (
                        <p>
                          Start by connecting a provider and configuring your
                          routes.
                        </p>
                      )}
                    </div>
                    <button
                      className="text-button"
                      onClick={() => setScreen("settings")}
                    >
                      {catalog ? "Configure routing" : "Connect your gateway"}
                      <Settings2 size={16} />
                    </button>
                  </div>
                ) : (
                  chat?.messages.map((m: Message) => {
                    const g = chat.generations.find(
                      (g) => g.id === m.generationId,
                    );
                    return (
                      <article className={`message ${m.role}`} key={m.id}>
                        <div className="message-heading">
                          <strong>{m.role === "user" ? "You" : "Omni"}</strong>
                          {m.role === "assistant" && (
                            <span>
                              {g?.resolvedModel || "Serving model unavailable"}
                            </span>
                          )}
                        </div>
                        <div className="message-content">
                          <MarkdownText
                            text={
                              m.content ||
                              (g?.status === "pending"
                                ? "Waiting for the gateway…"
                                : "No response text.")
                            }
                          />
                        </div>
                        {m.attachmentIds.length > 0 && (
                          <div className="message-files">
                            {m.attachmentIds.map((id) => (
                              <a key={id} href={`/api/attachments/${id}`}>
                                <Paperclip size={14} />
                                {chat.attachments.find((a) => a.id === id)
                                  ?.name || "Attachment"}
                              </a>
                            ))}
                          </div>
                        )}
                        <div className="message-actions">
                          <button
                            aria-label={`Copy ${m.role} message`}
                            onClick={() => copy(m.id, m.content)}
                          >
                            {copied === m.id ? (
                              <Check size={14} />
                            ) : (
                              <Copy size={14} />
                            )}
                          </button>
                          {m.role === "user" &&
                            m.id ===
                              chat.messages
                                .filter((m) => m.role === "user")
                                .at(-1)?.id && (
                              <button
                                disabled={Boolean(active)}
                                onClick={() => send(m.id)}
                              >
                                <RotateCcw size={14} />
                                Retry
                              </button>
                            )}
                          {g && (
                            <>
                              <span className={`status ${g.status}`}>
                                {g.status}
                              </span>
                              <Usage g={g} />
                            </>
                          )}
                        </div>
                        {g && (
                          <details className="generation-detail">
                            <summary>Request details</summary>
                            <p>
                              Requested:{" "}
                              {routeLabels[g.requestedRoute] ||
                                g.requestedRoute}
                            </p>
                            <p>
                              Provider: {g.provider || "Unavailable"} · Fallback
                              attempts: {g.fallback || "Unavailable"} · API
                              cost:{" "}
                              {g.cost == null ? "Unavailable" : `~$${g.cost}`}
                            </p>
                            {g.excludedMessageIds.length > 0 && (
                              <p>
                                Explicitly excluded{" "}
                                {g.excludedMessageIds.length} messages from this
                                request.
                              </p>
                            )}
                            {g.error && <p className="error-text">{g.error}</p>}
                          </details>
                        )}
                      </article>
                    );
                  })
                )}
                {sending && (
                  <>
                    {optimistic && (
                      <article className="message user">
                        <div className="message-heading">
                          <strong>You</strong>
                        </div>
                        <MarkdownText text={optimistic} />
                      </article>
                    )}
                    <article className="message assistant">
                      <div className="message-heading">
                        <strong>Omni</strong>
                        <span className="stream-status">Responding</span>
                      </div>
                      {liveText ? (
                        <MarkdownText text={liveText} />
                      ) : (
                        <p className="thinking">Finding an eligible route…</p>
                      )}
                    </article>
                  </>
                )}
                <div ref={bottom} />
              </div>
            </div>
            <footer className="composer-region">
              <div className="composer-inner">
                {contextOpen && chat && (
                  <section className="context-panel">
                    <div className="section-heading">
                      <h2>Context for the next request</h2>
                      <button
                        aria-label="Close context selection"
                        onClick={() => setContextOpen(false)}
                      >
                        <X size={16} />
                      </button>
                    </div>
                    <p>
                      Selected turns are explicitly excluded from the next
                      request. The transcript stays intact. Context uses the
                      latest answer for each prompt, including partial answers.
                    </p>
                    {chat.messages
                      .filter((m) => m.role === "user")
                      .map((m) => {
                        const index = chat.messages.indexOf(m),
                          following = chat.messages.slice(index + 1),
                          next = following.findIndex((m) => m.role === "user"),
                          turn = [
                            m,
                            ...(next < 0
                              ? following
                              : following.slice(0, next)),
                          ].map((m) => m.id);
                        return (
                          <label key={m.id}>
                            <input
                              type="checkbox"
                              checked={excluded.includes(m.id)}
                              onChange={(e) =>
                                setExcluded((old) =>
                                  e.target.checked
                                    ? [...new Set([...old, ...turn])]
                                    : old.filter((id) => !turn.includes(id)),
                                )
                              }
                            />
                            <span>
                              {m.content.slice(0, 90) || "Attachment prompt"}
                            </span>
                          </label>
                        );
                      })}
                  </section>
                )}
                {queued.length > 0 && (
                  <div className="attachment-queue">
                    {queued.map((a) => (
                      <div
                        key={a.id}
                        className={
                          a.status === "failed"
                            ? "file-chip failed"
                            : "file-chip"
                        }
                      >
                        <Paperclip size={14} />
                        <span>
                          {a.name}
                          {a.error && <small>{a.error}</small>}
                        </span>
                        <button
                          aria-label={`Remove ${a.name} from message`}
                          onClick={() =>
                            setQueued((q) => q.filter((x) => x.id !== a.id))
                          }
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <form
                  className="composer"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send();
                  }}
                >
                  <textarea
                    ref={draftRef}
                    aria-label="Message"
                    placeholder="Message Omni…"
                    rows={2}
                    value={draft}
                    disabled={sending}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        if (
                          !active &&
                          !uploading &&
                          (draft.trim() || queued.length)
                        )
                          void send();
                      }
                    }}
                  />
                  <div className="composer-tools">
                    <input
                      ref={fileRef}
                      type="file"
                      multiple
                      accept=".png,.jpg,.jpeg,.webp,.pdf,.docx,.txt,.md,.csv,.json"
                      hidden
                      onChange={(e) => attach(e.target.files)}
                    />
                    <button
                      type="button"
                      aria-label="Attach images or documents"
                      disabled={Boolean(active) || uploading}
                      onClick={() => fileRef.current?.click()}
                    >
                      <Paperclip size={18} />
                      {uploading ? "Processing…" : "Attach"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setContextOpen(!contextOpen)}
                      disabled={!chat?.messages.length}
                    >
                      Context
                      {excluded.length ? ` · ${excluded.length} excluded` : ""}
                    </button>
                    <label className="output-limit">
                      <span>Output limit</span>
                      <input
                        aria-label="Output token limit for this chat"
                        type="number"
                        min={128}
                        max={32768}
                        disabled={Boolean(active)}
                        value={chat?.outputCap || settings.outputCap}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (chat) setChat({ ...chat, outputCap: n });
                        }}
                        onBlur={(e) => {
                          if (chat)
                            void change({ outputCap: Number(e.target.value) });
                        }}
                      />
                    </label>
                    {active ? (
                      <button
                        type="button"
                        className="send-button stop"
                        aria-label="Stop response"
                        onClick={stopResponse}
                      >
                        <Square size={16} />
                      </button>
                    ) : (
                      <button
                        className="send-button"
                        aria-label="Send message"
                        disabled={
                          uploading || (!draft.trim() && !queued.length)
                        }
                      >
                        <ArrowUp size={20} />
                      </button>
                    )}
                  </div>
                </form>
                <div className="composer-footnote">
                  <span>
                    {settings.paidEnabled
                      ? "Paid APIs enabled"
                      : "Paid APIs disabled"}{" "}
                    · Requests reach your selected providers.
                  </span>
                  {chat && (
                    <a
                      href={`/api/conversations/${chat.id}/export?format=json`}
                    >
                      Export JSON
                    </a>
                  )}
                </div>
              </div>
            </footer>
          </>
        )}
      </section>
    </main>
  );
}
