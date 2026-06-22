import net from 'node:net';
import { EventEmitter } from 'node:events';

export interface QrcClientOptions {
  host: string;
  port?: number;
  /** Keepalive interval in ms. QRC closes idle sockets after 60s; default 30s. */
  keepAliveMs?: number;
  /** Per-request timeout in ms (default 10s). */
  requestTimeoutMs?: number;
  /**
   * Auto-reconnect on an unexpected socket drop (Core restart, leaving Emulate
   * mode, a network blip), replaying logon + change-group registrations so
   * polling resumes seamlessly. Default true. An explicit close() disables it.
   */
  reconnect?: boolean;
  /** Initial reconnect backoff in ms (default 500). */
  reconnectInitialMs?: number;
  /** Max reconnect backoff in ms (default 10_000). */
  reconnectMaxMs?: number;
  /** Consecutive background reconnect attempts before giving up until the next request (default 8). */
  reconnectMaxAttempts?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** Registrations we replay onto a fresh socket after a reconnect. */
interface ChangeGroupState {
  controls: Set<string>;
  components: Map<string, Set<string>>;
}

export class QrcError extends Error {
  code?: number;
  data?: unknown;
  constructor(err: unknown) {
    const o = (err && typeof err === 'object') ? err as Record<string, unknown> : null;
    super(o ? String(o.message ?? JSON.stringify(err)) : String(err));
    this.name = 'QrcError';
    if (o) {
      this.code = typeof o.code === 'number' ? o.code : undefined;
      this.data = o.data;
    }
  }
}

/**
 * Q-SYS Remote Control (QRC) client.
 * Speaks JSON-RPC 2.0 over a raw TCP socket (default port 1710), framed with
 * null terminators — the wire format QSC documents and that the Designer
 * Emulate-mode soft-core serves on localhost.
 *
 * Events: 'engineStatus' (params), 'notification' (full message), 'error', 'close',
 * plus reconnect lifecycle: 'reconnecting' (attempt #), 'reconnected',
 * 'reconnectError' ({attempt, error}), 'reconnectFailed'.
 */
export class QrcClient extends EventEmitter {
  private readonly host: string;
  private readonly port: number;
  private readonly keepAliveMs: number;
  private readonly requestTimeoutMs: number;
  private readonly reconnectEnabled: boolean;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  private readonly reconnectMaxAttempts: number;
  private socket: net.Socket | null = null;
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private connected = false;
  private explicitlyClosed = false;
  private reconnectPromise: Promise<void> | null = null;
  private logonCreds: { user: string; password: string } | null = null;
  private readonly changeGroups = new Map<string, ChangeGroupState>();

  constructor(opts: QrcClientOptions) {
    super();
    this.host = opts.host;
    this.port = opts.port ?? 1710;
    this.keepAliveMs = opts.keepAliveMs ?? 30_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.reconnectEnabled = opts.reconnect ?? true;
    this.reconnectInitialMs = opts.reconnectInitialMs ?? 500;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 10_000;
    this.reconnectMaxAttempts = opts.reconnectMaxAttempts ?? 8;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    this.explicitlyClosed = false;
    await this.openSocket();
  }

  /** Open a fresh socket and wire its handlers. Rejects if the TCP connect fails. */
  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      sock.setEncoding('utf8');
      const onConnectError = (e: Error) => reject(e);
      sock.once('error', onConnectError);
      sock.once('connect', () => {
        sock.removeListener('error', onConnectError);
        this.socket = sock;
        this.connected = true;
        this.buf = '';
        sock.on('data', (chunk: Buffer | string) => this.onData(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
        sock.on('error', (e: Error) => this.emitError(e));
        sock.on('close', () => this.onClose());
        this.startKeepAlive();
        resolve();
      });
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\0')) !== -1) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!raw.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        this.emitError(new Error(`QRC parse error: ${raw.slice(0, 200)}`));
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    const id = msg.id;
    if (typeof id === 'number' && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new QrcError(msg.error));
      else p.resolve(msg.result);
      return;
    }
    // Unsolicited notification (EngineStatus on connect, change-group autopolls, etc.)
    if (typeof msg.method === 'string') {
      if (msg.method === 'EngineStatus') this.emit('engineStatus', msg.params);
      this.emit('notification', msg);
    }
  }

  /**
   * Send a JSON-RPC request and await the correlated response. If the socket is
   * down (or drops mid-request) and auto-reconnect is enabled, this waits for a
   * reconnect and retries once — connection drops are transparent to callers.
   */
  async send(method: string, params?: unknown): Promise<unknown> {
    if (!this.connected) await this.ensureReconnected();
    try {
      return await this.sendOnce(method, params);
    } catch (err) {
      if (this.shouldRetryAfterDrop(err)) {
        await this.ensureReconnected();
        if (this.connected) return await this.sendOnce(method, params);
      }
      throw err;
    }
  }

  /** One request attempt on the current socket — no reconnect handling. */
  private sendOnce(method: string, params?: unknown): Promise<unknown> {
    if (!this.socket || !this.connected) {
      return Promise.reject(new Error('QRC not connected — call connect() first'));
    }
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', method, params: params ?? null, id }) + '\0';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`QRC request timed out: ${method} (id ${id})`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.write(frame);
    });
  }

  /** A connection drop is retryable; a timeout (socket still up) is not. */
  private shouldRetryAfterDrop(err: unknown): boolean {
    if (this.explicitlyClosed || !this.reconnectEnabled) return false;
    const m = (err as Error)?.message ?? '';
    return m.includes('QRC connection closed') || m.includes('QRC not connected');
  }

  /** Fire-and-forget notification (no id, no response expected). */
  notify(method: string, params?: unknown): void {
    if (!this.socket || !this.connected) return;
    this.socket.write(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? null }) + '\0');
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => this.notify('NoOp', {}), this.keepAliveMs);
    this.keepAliveTimer.unref?.();
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private onClose(): void {
    this.connected = false;
    this.stopKeepAlive();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('QRC connection closed'));
    }
    this.pending.clear();
    this.emit('close');
    // Kick a background reconnect on an unexpected drop. The !reconnectPromise
    // guard means a drop during an in-flight reconnect attempt won't start a
    // second loop (and our own teardownSocket() won't either).
    if (this.reconnectEnabled && !this.explicitlyClosed && !this.reconnectPromise) {
      void this.ensureReconnected();
    }
  }

  /** Resolve once connected, driving (or joining) a reconnect attempt as needed. */
  private ensureReconnected(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.explicitlyClosed || !this.reconnectEnabled) return Promise.resolve();
    if (!this.reconnectPromise) {
      this.reconnectPromise = this.runReconnect().finally(() => {
        this.reconnectPromise = null;
      });
    }
    return this.reconnectPromise;
  }

  /**
   * Re-dial with exponential backoff, then replay logon + change-group
   * registrations so polling resumes. Never rejects: callers read isConnected()
   * (or a subsequent sendOnce) for the outcome. Gives up after maxAttempts, but
   * the next request re-triggers a fresh attempt.
   */
  private async runReconnect(): Promise<void> {
    let delay = this.reconnectInitialMs;
    for (let attempt = 1; attempt <= this.reconnectMaxAttempts; attempt++) {
      if (this.explicitlyClosed) return;
      this.emit('reconnecting', attempt);
      try {
        await this.openSocket();
        await this.replayState();
        this.emit('reconnected');
        return;
      } catch (err) {
        this.teardownSocket();
        this.emit('reconnectError', { attempt, error: err as Error });
        if (attempt >= this.reconnectMaxAttempts) break;
        await this.sleep(delay);
        delay = Math.min(delay * 2, this.reconnectMaxMs);
      }
    }
    this.emit('reconnectFailed');
  }

  /** Re-establish session state on a fresh socket. Throws if any step fails. */
  private async replayState(): Promise<void> {
    if (this.logonCreds) {
      await this.sendOnce('Logon', { User: this.logonCreds.user, Password: this.logonCreds.password });
    }
    for (const [id, g] of this.changeGroups) {
      if (g.controls.size > 0) {
        await this.sendOnce('ChangeGroup.AddControl', { Id: id, Controls: [...g.controls] });
      }
      for (const [component, controls] of g.components) {
        if (controls.size > 0) {
          await this.sendOnce('ChangeGroup.AddComponentControl', {
            Id: id,
            Component: { Name: component, Controls: [...controls].map((n) => ({ Name: n })) },
          });
        }
      }
    }
  }

  /** Tear down the current socket without triggering reconnect (used between attempts). */
  private teardownSocket(): void {
    this.stopKeepAlive();
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });
  }

  close(): void {
    this.explicitlyClosed = true;
    this.stopKeepAlive();
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
    this.connected = false;
    this.changeGroups.clear();
    this.logonCreds = null;
  }

  /** Emit 'error' if anyone is listening; otherwise log to stderr instead of throwing. */
  private emitError(err: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', err);
    else console.error('[qrc]', err.message);
  }

  // ---- QRC method wrappers ----

  async logon(user: string, password: string): Promise<unknown> {
    const result = await this.send('Logon', { User: user, Password: password });
    this.logonCreds = { user, password }; // remembered so reconnect can re-auth
    return result;
  }

  statusGet(): Promise<EngineStatus> {
    return this.send('StatusGet', 0) as Promise<EngineStatus>;
  }

  getComponents(): Promise<QrcComponent[]> {
    return this.send('Component.GetComponents', null) as Promise<QrcComponent[]>;
  }

  getComponentControls(name: string): Promise<{ Name: string; Controls: QrcControl[] }> {
    return this.send('Component.GetControls', { Name: name }) as Promise<{ Name: string; Controls: QrcControl[] }>;
  }

  getComponent(name: string, controls: string[]): Promise<{ Name: string; Controls: QrcControl[] }> {
    return this.send('Component.Get', {
      Name: name,
      Controls: controls.map((n) => ({ Name: n })),
    }) as Promise<{ Name: string; Controls: QrcControl[] }>;
  }

  setComponent(name: string, controls: Array<{ Name: string; Value: ControlValue; Ramp?: number }>): Promise<unknown> {
    return this.send('Component.Set', { Name: name, Controls: controls });
  }

  getControl(names: string[]): Promise<QrcControl[]> {
    return this.send('Control.Get', names) as Promise<QrcControl[]>;
  }

  setControl(name: string, value: ControlValue, ramp?: number): Promise<unknown> {
    const params: Record<string, unknown> = { Name: name, Value: value };
    if (ramp != null) params.Ramp = ramp;
    return this.send('Control.Set', params);
  }

  async changeGroupAddControl(id: string, controls: string[]): Promise<unknown> {
    const result = await this.send('ChangeGroup.AddControl', { Id: id, Controls: controls });
    const g = this.groupState(id);
    for (const c of controls) g.controls.add(c);
    return result;
  }

  async changeGroupAddComponentControl(id: string, component: string, controls: string[]): Promise<unknown> {
    const result = await this.send('ChangeGroup.AddComponentControl', {
      Id: id,
      Component: { Name: component, Controls: controls.map((n) => ({ Name: n })) },
    });
    const set = this.groupState(id).components.get(component) ?? new Set<string>();
    for (const c of controls) set.add(c);
    this.groupState(id).components.set(component, set);
    return result;
  }

  changeGroupPoll(id: string): Promise<{ Id: string; Changes: QrcControl[] }> {
    return this.send('ChangeGroup.Poll', { Id: id }) as Promise<{ Id: string; Changes: QrcControl[] }>;
  }

  async changeGroupDestroy(id: string): Promise<unknown> {
    const result = await this.send('ChangeGroup.Destroy', { Id: id });
    this.changeGroups.delete(id); // stop replaying a group the caller tore down
    return result;
  }

  private groupState(id: string): ChangeGroupState {
    let g = this.changeGroups.get(id);
    if (!g) {
      g = { controls: new Set(), components: new Map() };
      this.changeGroups.set(id, g);
    }
    return g;
  }
}

export type ControlValue = number | string | boolean;

export interface EngineStatus {
  Platform: string;
  State: string;
  DesignName: string;
  DesignCode: string;
  IsRedundant: boolean;
  IsEmulator: boolean;
  Status: { Code: number; String: string };
}

export interface QrcComponent {
  ID?: string;
  Name: string;
  Type: string;
  Properties?: Array<{ Name: string; Value: string; PrettyName?: string }>;
}

export interface QrcControl {
  Name: string;
  Value: ControlValue;
  String?: string;
  Position?: number;
}
