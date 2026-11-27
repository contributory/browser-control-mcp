import type { BrowserSessions } from "../browser/session-contract.js";
import type { AppConfig } from "../config.js";
import type { Providers } from "../providers/index.js";

/** Everything the tool layer needs. Created once per process at startup. */
export interface AppContext {
  config: AppConfig;
  providers: Providers;
  sessions: BrowserSessions;
  /** Serverless invocations cannot guarantee persistent browser connections. */
  sessionMode?: "persistent" | "provider-managed" | "request";
}
