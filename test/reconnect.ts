import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startMockQrc } from './mock-qrc.js';
import { QrcClient } from '../src/qrc.js';

/**
 * Transparent auto-reconnect, offline against the mock QRC server.
 *
 * The headline proof: after the socket drops AND the server forgets its change
 * groups (resetState — a Core restart), polling the same group id still works.
 * That can only succeed if the client replayed its ChangeGroup.AddControl on the
 * fresh socket — without replay the mock answers "Unknown change group".
 */
function once(emitter: EventEmitter, event: string, timeoutMs: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for '${event}'`)), timeoutMs);
    t.unref?.();
    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(t);
      resolve(args);
    });
  });
}

async function main(): Promise<void> {
  const watchdog = setTimeout(() => {
    console.error('FAIL: reconnect test watchdog fired (something hung)');
    process.exit(1);
  }, 15_000);
  watchdog.unref?.();

  const mock = await startMockQrc();
  const client = new QrcClient({
    host: '127.0.0.1',
    port: mock.port,
    reconnectInitialMs: 20,
    reconnectMaxMs: 60,
    reconnectMaxAttempts: 50,
    requestTimeoutMs: 1000,
    keepAliveMs: 60_000, // keep NoOp out of the way of the test
  });

  await client.connect();

  // Register a change group and take the initial poll.
  await client.changeGroupAddControl('cg1', ['MainGain']);
  const poll1 = await client.changeGroupPoll('cg1');
  assert.ok(poll1.Changes.find((c) => c.Name === 'MainGain'), 'initial poll includes MainGain');

  // 1) Event-driven reconnect + replay across a Core-restart (state wiped).
  const reconnected = once(client, 'reconnected', 5000);
  mock.resetState();        // server forgets cg1
  mock.dropConnections();   // socket drops
  await reconnected;
  const poll2 = await client.changeGroupPoll('cg1');
  assert.ok(
    poll2.Changes.find((c) => c.Name === 'MainGain'),
    'poll after reconnect succeeds — change group was replayed onto the fresh server',
  );

  // 2) Transparent send-driven recovery: a tool call alone drives the reconnect.
  mock.resetState();
  mock.dropConnections();
  const status = await client.statusGet(); // no manual reconnect, no waiting on events
  assert.equal(status.IsEmulator, true, 'statusGet transparently reconnects and returns');

  // A write also round-trips after recovery.
  await client.setControl('MainGain', -8);
  assert.equal((await client.getControl(['MainGain']))[0].Value, -8, 'set/get works post-reconnect');

  client.close();

  // 3) reconnect:false stays down after a drop — the opt-out works.
  const noReconnect = new QrcClient({
    host: '127.0.0.1',
    port: mock.port,
    reconnect: false,
    requestTimeoutMs: 1000,
    keepAliveMs: 60_000,
  });
  let sawReconnecting = false;
  noReconnect.on('reconnecting', () => {
    sawReconnecting = true;
  });
  await noReconnect.connect();
  await noReconnect.statusGet(); // round-trip so the mock has registered the socket before we drop it
  mock.dropConnections();
  // The next call surfaces the drop and, with reconnect off, must not recover.
  await assert.rejects(
    () => noReconnect.statusGet(),
    /QRC not connected|QRC connection closed/,
    'reconnect:false → no auto-recovery',
  );
  assert.equal(sawReconnecting, false, 'reconnect:false never attempts a reconnect');
  noReconnect.close();

  await mock.close();
  clearTimeout(watchdog);
  console.log('PASS: transparent auto-reconnect (replay, send-driven recovery, opt-out)');
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
