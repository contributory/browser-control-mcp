import type { SessionRegistry } from "../browser/sessions.js";
import type { AppConfig } from "../config.js";
import type { Providers } from "../providers/index.js";

/** Everything the tool layer needs. Created once per process at startup. */
export interface AppContext {
  config: AppConfig;
  providers: Providers;
  sessions: SessionRegistry;
  /** Serverless invocations cannot guarantee persistent browser connections. */
  sessionMode?: "persistent" | "request";
}
