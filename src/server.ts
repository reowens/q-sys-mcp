import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { QrcClient, type EngineStatus, type QrcComponent, type QrcControl } from './qrc.js';

let client: QrcClient | null = null;
let lastEngineStatus: EngineStatus | null = null;

function ok(data: unknown) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text' as const, text }] };
}

function fail(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

function requireClient(): QrcClient {
  // Don't gate on isConnected(): a reconnect-enabled client may be mid-drop, and
  // its send() transparently waits for the socket to come back. Only a missing
  // client (never connected, or explicitly disconnected) is a hard error.
  if (!client) {
    throw new Error('Not connected to Q-SYS. Call qsys_connect first.');
  }
  return client;
}

/** Warn when a write targets a live Core rather than an emulator. */
function liveCoreWarning(): string | null {
  if (lastEngineStatus && lastEngineStatus.IsEmulator === false) {
    return `⚠ Writing to a LIVE Q-SYS Core (design "${lastEngineStatus.DesignName}"), not an emulator — this changes real audio.`;
  }
  return null;
}

const controlValue = z.union([z.number(), z.string(), z.boolean()]);

/** Client-side trim — QRC has no server-side filter/pagination, so we shape the full response. */
function shapeComponents(
  comps: QrcComponent[],
  opts: { filter?: string; type?: string; names_only?: boolean },
): unknown {
  let out = comps;
  if (opts.filter) {
    const f = opts.filter.toLowerCase();
    out = out.filter((c) => c.Name.toLowerCase().includes(f));
  }
  if (opts.type) {
    const t = opts.type.toLowerCase();
    out = out.filter((c) => (c.Type ?? '').toLowerCase().includes(t));
  }
  return opts.names_only ? out.map((c) => ({ Name: c.Name, Type: c.Type })) : out;
}

function shapeControls(
  res: { Name: string; Controls: QrcControl[] },
  opts: { filter?: string; names_only?: boolean },
): unknown {
  let ctrls = res.Controls;
  if (opts.filter) {
    const f = opts.filter.toLowerCase();
    ctrls = ctrls.filter((c) => c.Name.toLowerCase().includes(f));
  }
  if (opts.names_only) return { Name: res.Name, Controls: ctrls.map((c) => c.Name) };
  return { ...res, Controls: ctrls };
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'q-sys-mcp', version: '0.1.0' });

  server.registerTool(
    'qsys_connect',
    {
      title: 'Connect to Q-SYS',
      description:
        'Connect to a Q-SYS Core or to Q-SYS Designer running in Emulate mode (press F6 in Designer), over the QRC protocol (TCP). For a local emulator use host "127.0.0.1" and port 1710. Must be called before any other tool.',
      inputSchema: {
        host: z.string().default('127.0.0.1').describe('Core IP/hostname, or 127.0.0.1 for a local Designer emulator'),
        port: z.number().int().default(1710).describe('QRC port (default 1710)'),
        user: z.string().optional().describe('Username, if the design requires authentication'),
        password: z.string().optional().describe('Password, if the design requires authentication'),
        reconnect: z
          .boolean()
          .default(true)
          .describe('Auto-reconnect on a dropped socket (Core restart, network blip), replaying change-group registrations so polling resumes. Default true.'),
      },
    },
    async ({ host, port, user, password, reconnect }) => {
      try {
        if (client) client.close();
        const c = new QrcClient({ host, port, reconnect });
        c.on('engineStatus', (s: EngineStatus) => {
          lastEngineStatus = s;
        });
        c.on('error', () => {
          /* surfaced per-request; avoid crashing the server on transient socket errors */
        });
        c.on('reconnecting', (attempt: number) => console.error(`[qrc] connection dropped — reconnecting (attempt ${attempt})…`));
        c.on('reconnected', () => console.error('[qrc] reconnected; change-group registrations replayed'));
        c.on('reconnectFailed', () => console.error('[qrc] reconnect gave up; will retry on the next request'));
        await c.connect();
        if (user && password) await c.logon(user, password);
        client = c;
        const status = await c.statusGet();
        lastEngineStatus = status;
        return ok({ connected: true, host, port, status });
      } catch (e) {
        client = null;
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_status',
    {
      title: 'Q-SYS engine status',
      description: 'Get the Q-SYS engine status: platform, design name, run state, emulator flag.',
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await requireClient().statusGet());
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_list_components',
    {
      title: 'List components',
      description:
        'List named components in the running/emulated design, with type and properties (Component.GetComponents). On large designs use filter/type/names_only to trim the response.',
      inputSchema: {
        filter: z.string().optional().describe('Case-insensitive substring; only components whose name contains it are returned'),
        type: z.string().optional().describe('Case-insensitive substring on component type (e.g. "gain", "mixer")'),
        names_only: z.boolean().optional().describe('Return only name + type per component (drop properties) to save context'),
      },
    },
    async ({ filter, type, names_only }) => {
      try {
        return ok(shapeComponents(await requireClient().getComponents(), { filter, type, names_only }));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_get_component_controls',
    {
      title: 'Get component controls',
      description:
        "List a named component's controls and current values (Component.GetControls). Use filter/names_only to trim large components.",
      inputSchema: {
        name: z.string().describe('Component name (as returned by qsys_list_components)'),
        filter: z.string().optional().describe('Case-insensitive substring; only controls whose name contains it are returned'),
        names_only: z.boolean().optional().describe('Return only control names (drop values/positions) to save context'),
      },
    },
    async ({ name, filter, names_only }) => {
      try {
        return ok(shapeControls(await requireClient().getComponentControls(name), { filter, names_only }));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_get_control',
    {
      title: 'Get control values',
      description: 'Get the current values of one or more Named Controls (Control.Get).',
      inputSchema: { names: z.array(z.string()).min(1).describe('Named Control names') },
    },
    async ({ names }) => {
      try {
        return ok(await requireClient().getControl(names));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_get_component',
    {
      title: 'Get specific component control values',
      description: 'Get specific control values within a named component (Component.Get).',
      inputSchema: {
        name: z.string().describe('Component name'),
        controls: z.array(z.string()).min(1).describe('Control names within the component'),
      },
    },
    async ({ name, controls }) => {
      try {
        return ok(await requireClient().getComponent(name, controls));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_set_control',
    {
      title: 'Set a control value',
      description:
        'Set a Named Control value, optionally ramped over a number of seconds (Control.Set). This MUTATES the running/emulated system.',
      inputSchema: {
        name: z.string().describe('Named Control name'),
        value: controlValue.describe('New value (number, string, or boolean)'),
        ramp: z.number().optional().describe('Ramp time in seconds (optional)'),
      },
    },
    async ({ name, value, ramp }) => {
      try {
        const result = await requireClient().setControl(name, value, ramp);
        const warning = liveCoreWarning();
        return ok(warning ? { warning, result } : result);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_set_component',
    {
      title: 'Set component control values',
      description:
        'Set one or more control values within a named component, each optionally ramped (Component.Set). This MUTATES the running/emulated system.',
      inputSchema: {
        name: z.string().describe('Component name'),
        controls: z
          .array(
            z.object({
              name: z.string(),
              value: controlValue,
              ramp: z.number().optional(),
            }),
          )
          .min(1),
      },
    },
    async ({ name, controls }) => {
      try {
        const mapped = controls.map((c) => ({
          Name: c.name,
          Value: c.value,
          ...(c.ramp != null ? { Ramp: c.ramp } : {}),
        }));
        const result = await requireClient().setComponent(name, mapped);
        const warning = liveCoreWarning();
        return ok(warning ? { warning, result } : result);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_create_change_group',
    {
      title: 'Create or extend a change group',
      description:
        'Create a change group (or add Named Controls to an existing one) so you can poll for changes (ChangeGroup.AddControl).',
      inputSchema: {
        id: z.string().describe('Change group id (any string; reused on poll)'),
        controls: z.array(z.string()).min(1).describe('Named Control names to watch'),
      },
    },
    async ({ id, controls }) => {
      try {
        return ok(await requireClient().changeGroupAddControl(id, controls));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_poll_change_group',
    {
      title: 'Poll a change group',
      description: 'Poll a change group; returns the controls that changed since the last poll (ChangeGroup.Poll).',
      inputSchema: { id: z.string().describe('Change group id') },
    },
    async ({ id }) => {
      try {
        return ok(await requireClient().changeGroupPoll(id));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_change_group_add_component',
    {
      title: 'Add component controls to a change group',
      description:
        "Add a named component's controls to a change group so you can poll them for changes (ChangeGroup.AddComponentControl).",
      inputSchema: {
        id: z.string().describe('Change group id (any string; reused on poll)'),
        component: z.string().describe('Component name'),
        controls: z.array(z.string()).min(1).describe('Control names within the component to watch'),
      },
    },
    async ({ id, component, controls }) => {
      try {
        return ok(await requireClient().changeGroupAddComponentControl(id, component, controls));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_destroy_change_group',
    {
      title: 'Destroy a change group',
      description: 'Destroy a change group, freeing its server-side state (ChangeGroup.Destroy).',
      inputSchema: { id: z.string().describe('Change group id') },
    },
    async ({ id }) => {
      try {
        return ok(await requireClient().changeGroupDestroy(id));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  // ChangeGroup.AutoPoll is intentionally omitted in v1: MCP stdio is request/response,
  // so a Core-pushed poll has nowhere to land; manual qsys_poll_change_group covers it.
  server.registerTool(
    'qsys_disconnect',
    {
      title: 'Disconnect from Q-SYS',
      description: 'Close the QRC connection to the Core/emulator. A later qsys_connect is required before other tools.',
      inputSchema: {},
    },
    async () => {
      if (client) {
        client.close();
        client = null;
        lastEngineStatus = null;
      }
      return ok({ disconnected: true });
    },
  );

  return server;
}
