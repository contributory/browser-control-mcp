import type { ManagedSession, SessionSummary, SessionRegistry } from "./sessions.js";

/** Both local persistent and provider-managed sessions use this tool-facing contract. */
export interface BrowserSessions {
  listServices(): Array<{ name: string; reconnectable?: boolean; workflows?: boolean }>;
  open(service: string | undefined, owner: string, mode?: "workflow"): Promise<{ id: string; summary(): SessionSummary }>;
  withSession<T>(id: string, owner: string, fn: (session: ManagedSession) => Promise<T>): Promise<T>;
  close: SessionRegistry["close"];
}
