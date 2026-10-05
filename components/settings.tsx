"use client";
import { useState } from "react";
import {
  ArrowLeft,
  Check,
  ExternalLink,
  KeyRound,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { api, write } from "@/lib/client";
import {
  presets,
  type Settings,
  type Catalog,
  type Provider,
  type Connection,
} from "@/lib/types";
const labels = {
  balanced: "Balanced",
  quality: "Quality",
  fast: "Fast",
  economy: "Economy",
};
type OAuth = {
  id: string;
  kind: "device" | "browser";
  url: string;
  code: string | null;
  interval?: number;
};
export function SettingsView({
  settings,
  catalog,
  onSave,
  onBack,
  onRefresh,
}: {
  settings: Settings;
  catalog: Catalog | null;
  onSave: (s: Settings) => void;
  onBack: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [value, setValue] = useState(settings),
    [tab, setTab] = useState("routing"),
    [search, setSearch] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [provider, setProvider] = useState<Provider | null>(null),
    [name, setName] = useState(""),
    [key, setKey] = useState(""),
    [oauth, setOAuth] = useState<OAuth | null>(null),
    [callback, setCallback] = useState("");
  async function task(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    await task(async () => {
      const s = await api<Settings>("settings", write("PUT", value));
      onSave(s);
      setNotice("Settings saved.");
    });
  }
  async function connection(c: Connection, action: string) {
    await task(async () => {
      if (action === "remove" && !confirm(`Remove ${c.name} from OmniRoute?`))
        return;
      if (action === "test") {
        const r = await api<{ message: string }>(
          `providers/${c.id}/test`,
          write("POST", {}),
        );
        setNotice(r.message);
      } else
        await api(
          `providers/${c.id}`,
          write(
            action === "remove" ? "DELETE" : "PATCH",
            action === "remove" ? undefined : { isActive: !c.active },
          ),
        );
      await onRefresh();
    });
  }
  const providers =
    catalog?.providers.filter((p) =>
      p.id.toLowerCase().includes(search.toLowerCase()),
    ) || [];
  return (
    <section className="settings-page">
      <header className="settings-header">
        <button
          className="icon-button"
          aria-label="Back to chat"
          onClick={onBack}
        >
          <ArrowLeft size={20} />
        </button>
        <div>
          <h1>Settings</h1>
          <p>Choose your models. Keep control of your connections.</p>
        </div>
        <button className="primary" disabled={busy || !catalog} onClick={save}>
          <Check size={16} />
          Save changes
        </button>
      </header>
      <nav className="tabs" aria-label="Settings sections">
        {["routing", "providers", "preferences"].map((t) => (
          <button
            key={t}
            aria-current={tab === t ? "page" : undefined}
            onClick={() => setTab(t)}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>
      {error && (
        <div role="alert" className="alert">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="notice">
          {notice}
        </div>
      )}
      {!catalog && (
        <div className="empty-inline">
          <h2>Connect your gateway</h2>
          <p>
            Set OMNI_GATEWAY_URL and OMNI_MANAGEMENT_KEY on the server, then
            refresh. The gateway stays private.
          </p>
          <button onClick={() => task(onRefresh)} disabled={busy}>
            <RefreshCw size={16} />
            Test connection
          </button>
        </div>
      )}
      {tab === "routing" && (
        <>
          <div className="setting-row">
            <div>
              <h2>Usage-billed API models</h2>
              <p>
                Enable paid API connections across chats. Estimates are not a
                spending cap.
              </p>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={value.paidEnabled}
                onChange={(e) =>
                  setValue({ ...value, paidEnabled: e.target.checked })
                }
              />
              <span>{value.paidEnabled ? "Enabled" : "Disabled"}</span>
            </label>
          </div>
          <p className="section-description">
            Each preset uses OmniRoute’s automatic scoring with only the models
            you select. Vision and spending restrictions also apply to every
            fallback.
          </p>
          {presets.map((route) => (
            <section className="route-section" key={route}>
              <div className="route-title">
                <h2>{labels[route]}</h2>
                <span>
                  {value.routes[route].length
                    ? `${value.routes[route].length} selected`
                    : "Needs setup"}
                </span>
              </div>
              <div className="model-list">
                {catalog?.models.length ? (
                  catalog.models.map((m) => (
                    <label key={m.id} className="model-row">
                      <input
                        type="checkbox"
                        checked={value.routes[route].includes(m.id)}
                        disabled={
                          !value.routes[route].includes(m.id) &&
                          value.routes[route].length >= 10
                        }
                        onChange={(e) =>
                          setValue({
                            ...value,
                            routes: {
                              ...value.routes,
                              [route]: e.target.checked
                                ? [...value.routes[route], m.id]
                                : value.routes[route].filter(
                                    (id) => id !== m.id,
                                  ),
                            },
                          })
                        }
                      />
                      <span>
                        <strong>{m.name}</strong>
                        <small>{m.id}</small>
                      </span>
                      <span className="model-meta">
                        {m.vision ? "Vision · " : ""}
                        {m.context
                          ? `${Math.round(m.context / 1000)}k context`
                          : "Context unknown"}
                      </span>
                    </label>
                  ))
                ) : (
                  <p>
                    Connect and test a provider to discover available models.
                  </p>
                )}
              </div>
            </section>
          ))}
        </>
      )}
      {tab === "providers" && (
        <>
          <div className="section-heading">
            <div>
              <h2>Connections</h2>
              <p>
                Credentials stay in OmniRoute. Unknown billing types are treated
                as paid.
              </p>
            </div>
            <button disabled={busy} onClick={() => task(onRefresh)}>
              <RefreshCw size={16} />
              Refresh
            </button>
          </div>
          {catalog?.connections.map((c) => (
            <div className="connection-row" key={c.id}>
              <div>
                <strong>{c.name}</strong>
                <small>
                  {c.provider} · {c.status} ·{" "}
                  {c.active ? "Enabled" : "Disabled"}
                </small>
              </div>
              <label>
                <span className="sr-only">Billing type for {c.name}</span>
                <select
                  value={value.billing[c.id] || "paid"}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      billing: {
                        ...value.billing,
                        [c.id]: e.target.value as "subscription" | "paid",
                      },
                    })
                  }
                >
                  <option value="paid">Usage-billed / unknown</option>
                  <option value="subscription">Included in subscription</option>
                </select>
              </label>
              <button disabled={busy} onClick={() => connection(c, "test")}>
                Test
              </button>
              <button disabled={busy} onClick={() => connection(c, "toggle")}>
                {c.active ? "Disable" : "Enable"}
              </button>
              <button
                className="icon-button"
                disabled={busy}
                aria-label={`Remove ${c.name}`}
                onClick={() => connection(c, "remove")}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          <p className="section-description">
            Only classify a connection as subscription-included after verifying
            its plan. Some subscriptions allow extra usage charges; disable that
            in the provider’s account settings if needed.
          </p>
          <div className="section-heading">
            <h2>Add a provider</h2>
            <label className="search">
              <Search size={16} />
              <input
                aria-label="Search provider catalog"
                placeholder="Search providers"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          </div>
          <div className="provider-list">
            {providers.map((p) => (
              <button
                key={p.id}
                className="provider-row"
                onClick={() => {
                  setProvider(p);
                  setName(p.name);
                  setKey("");
                  setOAuth(null);
                  setCallback("");
                }}
              >
                <span>
                  {p.name}
                  <small>{p.models} catalog models</small>
                </span>
                <span>
                  {p.setup === "key"
                    ? "API key"
                    : p.setup === "device"
                      ? "Device sign-in"
                      : p.setup === "browser"
                        ? "Browser sign-in"
                        : "External setup"}
                  <ExternalLink size={14} />
                </span>
              </button>
            ))}
          </div>
          {provider && (
            <section
              className="provider-setup"
              aria-label={`Connect ${provider.name}`}
            >
              <div className="section-heading">
                <h2>Connect {provider.name}</h2>
                <button onClick={() => setProvider(null)}>Close</button>
              </div>
              {provider.capabilities.includes("apikey") && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void task(async () => {
                      await api(
                        "providers",
                        write("POST", {
                          provider: provider.id,
                          name,
                          apiKey: key,
                        }),
                      );
                      setKey("");
                      setNotice(
                        "Connection added. Test it and classify its billing type.",
                      );
                      await onRefresh();
                    });
                  }}
                >
                  <label>
                    Connection name
                    <input
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <label>
                    API key
                    <input
                      required
                      type="password"
                      autoComplete="off"
                      value={key}
                      onChange={(e) => setKey(e.target.value)}
                    />
                  </label>
                  <button className="primary" disabled={busy}>
                    <KeyRound size={16} />
                    Add connection
                  </button>
                </form>
              )}
              {(provider.setup === "device" || provider.setup === "browser") &&
                !oauth && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      task(async () => {
                        const result = await api<OAuth>(
                          `providers/${provider.id}/oauth`,
                          write("POST", {}),
                        );
                        if (!/^https:\/\//.test(result.url))
                          throw new Error(
                            "Gateway did not return a secure authorization URL. Use the external guide.",
                          );
                        setOAuth(result);
                      })
                    }
                  >
                    Start {provider.setup} sign-in
                  </button>
                )}
              {oauth && (
                <div className="oauth">
                  <p>
                    Open the provider’s authorization page in a separate tab.
                  </p>
                  <a href={oauth.url} target="_blank" rel="noopener noreferrer">
                    Authorize {provider.name}
                    <ExternalLink size={14} />
                  </a>
                  {oauth.code && (
                    <p>
                      Your code: <strong>{oauth.code}</strong>
                    </p>
                  )}
                  {oauth.kind === "browser" && (
                    <label>
                      Callback URL
                      <input
                        value={callback}
                        onChange={(e) => setCallback(e.target.value)}
                        placeholder="Paste the final URL after authorization"
                      />
                    </label>
                  )}
                  <button
                    disabled={busy}
                    onClick={() =>
                      task(async () => {
                        const r = await api<{
                          success: boolean;
                          pending: boolean;
                        }>(
                          `oauth/${oauth.id}`,
                          write(
                            "POST",
                            oauth.kind === "browser" ? { callback } : {},
                          ),
                        );
                        if (r.success) {
                          setOAuth(null);
                          setNotice(
                            "Provider connected. Refresh, test, and classify its billing type.",
                          );
                          await onRefresh();
                        } else
                          setNotice(
                            "Authorization is still pending. Finish sign-in, then check again.",
                          );
                      })
                    }
                  >
                    Check authorization
                  </button>
                </div>
              )}
              {provider.setup === "external" && (
                <>
                  <p>
                    This connection needs a local helper, a provider-specific
                    import, or gateway configuration. Omni does not claim
                    browser-only setup for this provider.
                  </p>
                  <ol>
                    <li>
                      Open the protected OmniRoute dashboard through your
                      server’s SSH tunnel.
                    </li>
                    <li>
                      Follow the provider’s connection dialog. Forward any local
                      callback ports it specifies.
                    </li>
                    <li>
                      Return here and refresh connections, then test the
                      connection.
                    </li>
                  </ol>
                  <a
                    href="https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/docs/guides/REMOTE-MODE.md"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Read the pinned remote setup guide{" "}
                    <ExternalLink size={14} />
                  </a>
                </>
              )}
              {provider.setup !== "external" && (
                <p>
                  To reconnect, repeat the authorization flow or add the
                  replacement key, test it, and remove the old connection.
                </p>
              )}
            </section>
          )}
        </>
      )}
      {tab === "preferences" && (
        <>
          <div className="setting-row">
            <div>
              <h2>Appearance</h2>
              <p>Follow your device or choose a theme.</p>
            </div>
            <select
              aria-label="Theme"
              value={value.theme}
              onChange={(e) =>
                setValue({
                  ...value,
                  theme: e.target.value as Settings["theme"],
                })
              }
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>
          <div className="setting-row">
            <div>
              <h2>Default response limit</h2>
              <p>
                New chats start with this output-token cap. Existing chats
                retain their own limit.
              </p>
            </div>
            <input
              aria-label="Default output token cap"
              type="number"
              min={128}
              max={32768}
              value={value.outputCap}
              onChange={(e) =>
                setValue({ ...value, outputCap: Number(e.target.value) })
              }
            />
          </div>
          <div className="setting-row">
            <div>
              <h2>Attachment limits</h2>
              <p>
                Six files per message, 10 MB per file. PDFs: 100 text-based
                pages. Document text: 200,000 characters. Scans require OCR and
                cannot be read here.
              </p>
            </div>
          </div>
          <div className="setting-row">
            <div>
              <h2>Gateway version</h2>
              <p>
                Contract pinned to OmniRoute 3.8.51. Live provider compatibility
                still requires connection testing.
              </p>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
