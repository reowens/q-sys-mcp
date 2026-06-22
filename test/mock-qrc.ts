import net from 'node:net';

/**
 * Minimal in-memory QRC server for deterministic tests. Speaks the same
 * null-terminated JSON-RPC 2.0 wire format as a real Core / Designer emulator:
 * sends EngineStatus on connect, answers the methods the client uses.
 */
export interface MockHandle {
  port: number;
  close: () => Promise<void>;
  /** Destroy all live client sockets (simulates a Core dropping the connection). */
  dropConnections: () => void;
  /** Clear server-side change groups (simulates a Core restart losing them). */
  resetState: () => void;
}

interface State {
  controls: Record<string, number>;
  componentControls: Record<string, Record<string, number>>;
  changeGroups: Record<
    string,
    {
      controls: Set<string>;
      componentControls: Array<{ component: string; control: string }>;
      lastSent: Record<string, number>;
    }
  >;
}

export function startMockQrc(port = 0): Promise<MockHandle> {
  const state: State = {
    controls: { MainGain: -10, MainMute: 0 },
    componentControls: { Gain1: { gain: -6, mute: 0 } },
    changeGroups: {},
  };

  const sockets = new Set<net.Socket>();

  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    let buf = '';
    const send = (obj: unknown) => sock.write(JSON.stringify(obj) + '\0');

    // Auto EngineStatus on connect (matches real Core/emulator behaviour).
    send({
      jsonrpc: '2.0',
      method: 'EngineStatus',
      params: {
        Platform: 'MockEmulator',
        State: 'Active',
        DesignName: 'MockDesign',
        DesignCode: 'mock',
        IsRedundant: false,
        IsEmulator: true,
        Status: { Code: 0, String: 'OK' },
      },
    });

    sock.on('data', (chunk: Buffer | string) => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\0')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!raw.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(raw);
        } catch {
          continue;
        }
        handle(msg, send, state);
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        port: addr.port,
        close: () => new Promise<void>((r) => server.close(() => r())),
        dropConnections: () => {
          for (const s of sockets) s.destroy();
          sockets.clear();
        },
        resetState: () => {
          state.changeGroups = {};
        },
      });
    });
  });
}

function handle(msg: any, send: (o: unknown) => void, st: State): void {
  const reply = (result: unknown) => {
    if (msg.id !== undefined) send({ jsonrpc: '2.0', result, id: msg.id });
  };
  const error = (code: number, message: string) => {
    if (msg.id !== undefined) send({ jsonrpc: '2.0', error: { code, message }, id: msg.id });
  };

  switch (msg.method) {
    case 'NoOp':
      return;
    case 'Logon':
      return reply({});
    case 'StatusGet':
      return reply({
        Platform: 'MockEmulator',
        State: 'Active',
        DesignName: 'MockDesign',
        DesignCode: 'mock',
        IsRedundant: false,
        IsEmulator: true,
        Status: { Code: 0, String: 'OK' },
      });
    case 'Component.GetComponents':
      return reply([
        { ID: 'Gain1', Name: 'Gain1', Type: 'gain', Properties: [] },
        { ID: 'Mixer1', Name: 'Mixer1', Type: 'mixer', Properties: [] },
        { ID: 'Gain2', Name: 'Gain2', Type: 'gain', Properties: [] },
      ]);
    case 'Component.GetControls': {
      const name = msg.params?.Name;
      const cc = st.componentControls[name];
      if (!cc) return error(-32602, `Unknown component: ${name}`);
      return reply({
        Name: name,
        Controls: Object.entries(cc).map(([n, v]) => ({ Name: n, Value: v, String: String(v), Position: 0 })),
      });
    }
    case 'Component.Get': {
      const name = msg.params?.Name;
      const cc = st.componentControls[name];
      if (!cc) return error(-32602, `Unknown component: ${name}`);
      const reqd: string[] = (msg.params?.Controls ?? []).map((c: any) => c.Name);
      return reply({
        Name: name,
        Controls: reqd.map((n) => ({ Name: n, Value: cc[n], String: String(cc[n]), Position: 0 })),
      });
    }
    case 'Component.Set': {
      const name = msg.params?.Name;
      const cc = st.componentControls[name];
      if (!cc) return error(-32602, `Unknown component: ${name}`);
      for (const c of msg.params?.Controls ?? []) cc[c.Name] = c.Value;
      return reply(null);
    }
    case 'Control.Get': {
      const names: string[] = msg.params ?? [];
      return reply(names.map((n) => ({ Name: n, Value: st.controls[n] ?? 0, String: String(st.controls[n] ?? 0), Position: 0 })));
    }
    case 'Control.Set':
      st.controls[msg.params.Name] = msg.params.Value;
      return reply(null);
    case 'ChangeGroup.AddControl': {
      const id = msg.params.Id;
      st.changeGroups[id] ??= { controls: new Set(), componentControls: [], lastSent: {} };
      for (const c of msg.params.Controls) st.changeGroups[id].controls.add(c);
      return reply(null);
    }
    case 'ChangeGroup.AddComponentControl': {
      const id = msg.params.Id;
      st.changeGroups[id] ??= { controls: new Set(), componentControls: [], lastSent: {} };
      const component = msg.params.Component?.Name;
      for (const c of msg.params.Component?.Controls ?? []) {
        st.changeGroups[id].componentControls.push({ component, control: c.Name });
      }
      return reply(null);
    }
    case 'ChangeGroup.Destroy': {
      delete st.changeGroups[msg.params.Id];
      return reply(null);
    }
    case 'ChangeGroup.Poll': {
      const id = msg.params.Id;
      const g = st.changeGroups[id];
      if (!g) return error(-32602, `Unknown change group: ${id}`);
      const changes: Array<{ Name: string; Value: number; String: string }> = [];
      for (const n of g.controls) {
        const v = st.controls[n] ?? 0;
        if (g.lastSent[n] !== v) {
          changes.push({ Name: n, Value: v, String: String(v) });
          g.lastSent[n] = v;
        }
      }
      for (const { component, control } of g.componentControls) {
        const key = `${component}/${control}`;
        const v = st.componentControls[component]?.[control] ?? 0;
        if (g.lastSent[key] !== v) {
          changes.push({ Name: control, Value: v, String: String(v) });
          g.lastSent[key] = v;
        }
      }
      return reply({ Id: id, Changes: changes });
    }
    default:
      return error(-32601, `Method not found: ${msg.method}`);
  }
}
