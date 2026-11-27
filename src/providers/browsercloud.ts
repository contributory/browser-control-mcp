import type { OpenOptions, PlaywrightProvider, ProviderSession } from "./types.js";

const DEFAULT_ENDPOINT = "wss://chrome-v2.browsercloud.io/";

/**
 * BrowserCloud: connect to the configured endpoint with the account token.
 * https://browsercloud.io/docs/launch-options
 *
 * The token is placed in the query string, so the whole connection URL is
 * treated as a secret: it is redacted from errors and never returned.
 */
export class BrowserCloudProvider implements PlaywrightProvider {
  readonly name = "browsercloud";
  readonly connectionKind = "cdp" as const;

  constructor(
    private readonly token: string,
    private readonly endpoint: string = DEFAULT_ENDPOINT,
  ) {}

  async open(_options: OpenOptions): Promise<ProviderSession> {
    const endpoint = new URL(this.endpoint);
    endpoint.searchParams.set("token", this.token);
    return {
      providerSessionId: `browsercloud:${endpoint.host}`,
      endpoint: endpoint.toString(),
      connectionKind: this.connectionKind,
      async stop() {
        // BrowserCloud releases the connection when the WebSocket detaches.
      },
    };
  }
}
