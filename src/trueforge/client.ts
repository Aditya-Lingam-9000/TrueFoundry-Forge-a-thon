/**
 * Minimal TrueForge HTTP client: sessions, streamed turns (SSE), cancel, MCP-server registration.
 * Wire format is TrueForge's REST API (snake_case), as documented by its OpenAPI spec at
 * /api/v1/openapi.json. The extension never talks to a model provider: every model call goes
 * through TrueForge.
 */

/** The part of a stored model-provider manifest the extension reads. */
interface ProviderManifest {
  name?: string;
  type?: string;
  models?: Array<{ name?: string; properties?: { max_output_tokens?: unknown } }>;
}

/** Loosely typed TrueForge turn event: `type` discriminates, the rest is event-specific. */
export interface TurnEvent {
  type: string;
  id?: string;
  thread_id?: string | null;
  [key: string]: unknown;
}

export interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export type TurnInput =
  | { type: 'user.message'; content: string }
  | {
      type: 'user.tool_approval';
      thread_id: string;
      tool_call_id: string;
      approval: { status: 'allow' } | { status: 'deny'; reason?: string };
    };

export interface RemoteMcpServerManifest {
  type: 'remote';
  name: string;
  url: string;
  description: string;
  auth?: { type: 'header'; headers: Record<string, string> };
}

export class TrueForgeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TrueForgeError';
  }
}

export class TrueForgeClient {
  constructor(private readonly baseUrl: () => string) {}

  private url(path: string): string {
    return this.baseUrl().replace(/\/+$/, '') + path;
  }

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw new TrueForgeError(
        `Cannot reach TrueForge at ${this.baseUrl()} (${errorMessage(err)}). Is it running? ` +
          'Start it with scripts/start-trueforge.sh.',
      );
    }
    const text = await res.text();
    if (!res.ok) {
      throw new TrueForgeError(`TrueForge ${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 500)}`, res.status);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** GET /healthz → { status, version } */
  health(): Promise<{ status: string; version?: string }> {
    return this.request('GET', '/healthz');
  }

  /** Create or replace an MCP server connector (PUT /api/v1/settings/mcp-servers). */
  async putMcpServer(manifest: RemoteMcpServerManifest): Promise<void> {
    await this.request('PUT', '/api/v1/settings/mcp-servers', { manifest });
  }

  /** Create a session from an inline agent spec; returns the session id. */
  async createSession(spec: unknown, metadata: Record<string, string>): Promise<string> {
    const res = await this.request<{ data?: { id?: string } }>('POST', '/api/v1/sessions', {
      agent: { spec },
      metadata,
    });
    const id = res?.data?.id;
    if (!id) {
      throw new TrueForgeError('TrueForge created a session but returned no id');
    }
    return id;
  }

  /**
   * Output-token limit that a configured model declares in TrueForge (`<provider>/<model>` →
   * properties.max_output_tokens), or undefined. TrueForge does not cap max_tokens itself.
   */
  async modelOutputLimit(model: string): Promise<number | undefined> {
    const [provider, name] = [model.slice(0, model.indexOf('/')), model.slice(model.indexOf('/') + 1)];
    const res = await this.request<{ data?: unknown }>('GET', '/api/v1/settings/model-providers');
    const items = Array.isArray(res?.data) ? res.data : [];
    for (const item of items as Array<{ manifest?: ProviderManifest } & ProviderManifest>) {
      const m = item.manifest ?? item;
      if ((m.name ?? m.type) === provider) {
        const limit = m.models?.find(x => x.name === name)?.properties?.max_output_tokens;
        return typeof limit === 'number' && limit > 0 ? limit : undefined;
      }
    }
    return undefined;
  }

  /** Replace the inline agent spec of a session, e.g. to switch its model (PATCH /api/v1/sessions/{id}). */
  async updateSessionSpec(sessionId: string, spec: unknown): Promise<void> {
    await this.request('PATCH', `/api/v1/sessions/${encodeURIComponent(sessionId)}`, { agent: { spec } });
  }

  /** Cancel whatever is running in the session (idempotent). */
  async cancel(sessionId: string): Promise<void> {
    await this.request('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/cancel`, {});
  }

  /** Events of one turn (deltas already merged), oldest first. */
  async turnEvents(sessionId: string, turnId: string): Promise<TurnEvent[]> {
    const res = await this.request<{ data?: TurnEvent[] }>(
      'GET',
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/events?order=asc&limit=100`,
    );
    return res?.data ?? [];
  }

  /**
   * Start a turn and yield its events as they stream in (SSE). `input` is a user message or the
   * batch of approval decisions answering a `tool.approval_required`. Ends after `turn.done` or
   * when the stream closes. `signal` aborts the HTTP stream (the turn itself is cancelled with
   * cancel()). `previousTurnId` chains the turn to an earlier one ("none": a new root turn);
   * omitted, TrueForge chains it to the session's last turn.
   */
  async *streamTurn(
    sessionId: string,
    input: TurnInput[],
    signal: AbortSignal,
    previousTurnId?: string,
  ): AsyncGenerator<TurnEvent> {
    let res: Response;
    try {
      res = await fetch(this.url(`/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(previousTurnId ? { input, stream: true, previous_turn_id: previousTurnId } : { input, stream: true }),
        signal,
      });
    } catch (err) {
      if (signal.aborted) {
        return;
      }
      throw new TrueForgeError(`Cannot reach TrueForge at ${this.baseUrl()} (${errorMessage(err)})`);
    }
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw new TrueForgeError(`TrueForge rejected the turn: HTTP ${res.status} ${body.slice(0, 500)}`, res.status);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const chunk = await reader.read().catch((err: unknown) => {
          if (signal.aborted) {
            return undefined;
          }
          throw new TrueForgeError(`The TrueForge stream broke: ${errorMessage(err)}`);
        });
        if (chunk === undefined) {
          return;
        }
        if (chunk.done) {
          break;
        }
        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = parseSseFrame(frame);
          if (event) {
            yield event;
            if (event.type === 'turn.done') {
              return;
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
      const last = parseSseFrame(buffer);
      if (last) {
        yield last;
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/** One SSE frame → event. Joins multi-line `data:` fields; ignores comments and ids. */
function parseSseFrame(frame: string): TurnEvent | undefined {
  const data = frame
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(data);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
      return parsed as TurnEvent;
    }
  } catch {
    // not JSON: ignore the frame
  }
  return undefined;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message}: ${cause.message}` : err.message;
  }
  return String(err);
}
