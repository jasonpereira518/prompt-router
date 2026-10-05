export const presets = ["balanced", "quality", "fast", "economy"] as const;
export type Preset = (typeof presets)[number];
export type Status =
  "pending" | "completed" | "stopped" | "failed" | "interrupted";
export type Billing = "subscription" | "paid";
export interface Settings {
  paidEnabled: boolean;
  outputCap: number;
  routes: Record<Preset, string[]>;
  billing: Record<string, Billing>;
  theme: "system" | "light" | "dark";
}
export const defaults: Settings = {
  paidEnabled: false,
  outputCap: 2048,
  routes: { balanced: [], quality: [], fast: [], economy: [] },
  billing: {},
  theme: "system",
};
export interface Attachment {
  id: string;
  conversationId: string;
  name: string;
  type: string;
  size: number;
  status: "ready" | "failed";
  error: string | null;
  text: string | null;
  path: string;
}
export interface Generation {
  excludedMessageIds: string[];
  id: string;
  conversationId: string;
  requestedRoute: string;
  resolvedModel: string | null;
  provider: string | null;
  status: Status;
  error: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
  latency: number | null;
  fallback: string | null;
  createdAt: string;
}
export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  generationId: string | null;
  attachmentIds: string[];
}
export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  route: string;
  outputCap: number;
}
export interface ConversationDetail extends Conversation {
  messages: Message[];
  generations: Generation[];
  attachments: Attachment[];
}
export interface Model {
  id: string;
  name: string;
  provider: string;
  vision: boolean;
  context: number | null;
  maxOutput: number | null;
  unsupportedParams: string[];
}
export interface Provider {
  id: string;
  alias: string;
  name: string;
  capabilities: string[];
  authType: string;
  models: number;
  setup: "device" | "browser" | "external" | "key";
}
export interface Connection {
  id: string;
  provider: string;
  name: string;
  active: boolean;
  authType: string;
  status: string;
}
export interface Catalog {
  version: string;
  providers: Provider[];
  connections: Connection[];
  models: Model[];
}
