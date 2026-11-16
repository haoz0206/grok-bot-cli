import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, rstest } from '@rstest/core';
import { createAgentRenderEventSequence } from '@agent-bundle/runtime';
import * as bridge from '../../src/core/codex-bridge.js';
import { appServerListThreads } from '../../src/core/chatgpt-desktop/app-server-fallback.js';
import { ChatGptDesktopFacade } from '../../src/core/chatgpt-desktop/facade.js';
import { LIST_THREADS_EXPRESSION, listThreadsFromDom } from '../../src/core/chatgpt-desktop/cdp-dom.js';
import { CdpUnreachableError } from '../../src/core/chatgpt-desktop/errors.js';
import { openThreadSchema, sendSchema } from '../../src/core/chatgpt-desktop/routes.js';
import openTool from '../../src/mcp/grok-bot/tools/chatgpt_desktop_open_thread.js';
import sendTool from '../../src/mcp/grok-bot/tools/chatgpt_desktop_send.js';
import type { ChatGptDesktopAdapter } from '../../src/core/chatgpt-desktop/adapter.js';
import type { ChatGptDesktopFallbacks } from '../../src/core/chatgpt-desktop/facade.js';
import type { ChatGptDesktopThread } from '../../src/core/chatgpt-desktop/types.js';

let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), 'gbot-desktop-architecture-'));
  process.env.CODEX_HOME = home;
});
afterEach(() => {
  rstest.restoreAllMocks();
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

const row = (id: string): ChatGptDesktopThread => ({ threadId: `local:${id}`, title: id,
  pinned: false, selected: false, kind: 'codex' });
const offline = (): never => { throw new CdpUnreachableError('fixture offline'); };
const unexpected = async (): Promise<never> => { throw new Error('unexpected Desktop operation'); };
function cdpFixture(threads: readonly ChatGptDesktopThread[], connect = async () => {}): ChatGptDesktopAdapter {
  return { connect, listThreads: async () => ({ backend: 'cdp', limit: 200, threads }),
    listTargets: unexpected, readThread: unexpected, sendMessage: unexpected,
    waitForReply: unexpected, openThread: unexpected, status: unexpected, close: async () => {} };
}
function facade(threads: readonly ChatGptDesktopThread[], fallbacks: Partial<ChatGptDesktopFallbacks> = {}, connect = async () => {}) {
  return new ChatGptDesktopFacade(cdpFixture(threads, connect), 9222, {
    listThreads: async () => ({ backend: 'app-server', limit: 200, threads: [], nextCursor: null }),
    searchThreads: async () => ({ backend: 'app-server', limit: 200, threads: [], nextCursor: null }),
    readThread: async () => { throw new Error('unexpected read'); },
    statusProbe: async () => ({ reachable: true, mode: 'daemon' }),
    listRemoteThreads: () => [], listHosts: () => [],
    ...fallbacks,
  });
}

it('derives hosts and providers from one app pagination walk and one CDP inventory', async () => {
  const rpc = rstest.spyOn(bridge, 'listCodexThreads').mockImplementation(async ({ limit = 25, cursor } = {}) => {
    const offset = Number(cursor ?? 0);
    return { limit, threads: Array.from({ length: Math.min(limit, 50 - offset) }, (_, index) => ({
      id: `thread-${offset + index}`, modelProvider: offset ? 'second' : 'first',
    })), nextCursor: offset + limit < 50 ? String(offset + limit) : null } as never;
  });
  const sidebar = cdpFixture([]);
  const cdpCalls = rstest.spyOn(sidebar, 'listThreads');
  const adapter = new ChatGptDesktopFacade(sidebar, 9222, {
    searchThreads: unexpected, readThread: unexpected, statusProbe: unexpected,
    listThreads: appServerListThreads, listRemoteThreads: () => [],
    listHosts: () => [{ hostId: 'local', hostName: 'local', location: 'local', threadCount: 0 },
      { hostId: 'managed-empty', hostName: 'empty', location: 'remote', threadCount: 0 }],
  });
  const result = await adapter.listHosts();
  expect(result.hosts.map(host => [host.hostId, host.threadCount])).toEqual([['local', 50], ['managed-empty', 0]]);
  expect(result.modelProviders).toEqual(['first', 'second']);
  expect([rpc.mock.calls.length, cdpCalls.mock.calls.length]).toEqual([2, 1]);
  await adapter.listHosts();
  expect([rpc.mock.calls.length, cdpCalls.mock.calls.length]).toEqual([2, 1]);
});

it('preserves partial app counts, remote providers and source warnings', async () => {
  const remote = { ...row('remote'), location: 'remote' as const, hostId: 'remote', hostName: null, modelProvider: 'remote-provider' };
  const desktop = facade([], {
    listThreads: async ({ cursor } = {}) => {
      if (cursor) throw new Error('second page unavailable');
      return { backend: 'app-server', limit: 200, threads: [{ ...row('first'), modelProvider: 'local-provider' }], nextCursor: 'next', warnings: ['source warning'] };
    },
    listRemoteThreads: () => [remote],
  }, async () => offline());
  const result = await desktop.listHosts();
  expect(result.hosts).toEqual(expect.arrayContaining([
    expect.objectContaining({ hostId: 'local', threadCount: 1 }),
    expect.objectContaining({ hostId: 'remote', threadCount: 1 }),
  ]));
  expect(result.modelProviders).toEqual(['local-provider', 'remote-provider']);
  expect(result.warnings).toEqual(expect.arrayContaining(['source warning', 'App-server list failed: second page unavailable',
    'Provider discovery stopped before the final app-server page']));
});

it('keeps earlier inventory pages when a later app-server RPC fails', async () => {
  const rpc = rstest.spyOn(bridge, 'listCodexThreads').mockImplementation(async ({ cursor } = {}) => {
    if (cursor) throw new Error('second RPC offline');
    return { limit: 25, threads: Array.from({ length: 25 }, (_, index) => ({ id: `partial-${index}`, modelProvider: 'partial-provider' })), nextCursor: 'next' } as never;
  });
  const result = await facade([], { listThreads: appServerListThreads }, async () => offline()).listHosts();
  expect(result.hosts).toContainEqual(expect.objectContaining({ hostId: 'local', threadCount: 25 }));
  expect(result.modelProviders).toEqual(['partial-provider']);
  expect(result.warnings).toContain('App-server list failed: second RPC offline');
  expect(result.warnings).toContain('Provider discovery stopped before the final app-server page');
  expect(result.warnings).not.toContain('App-server inventory stopped after 3200 pages');
  expect(rpc.mock.calls).toHaveLength(2);
});

it('refreshes host inventory after a partial app-server failure recovers', async () => {
  let recovered = false;
  const desktop = facade([], {
    listThreads: async ({ cursor } = {}) => {
      if (cursor && !recovered) throw new Error('temporary second-page failure');
      return recovered
        ? { backend: 'app-server', limit: 200, threads: [row('first'), row('second')] }
        : { backend: 'app-server', limit: 200, threads: [row('first')], nextCursor: 'next' };
    },
  }, async () => offline());

  expect((await desktop.listHosts()).hosts.find(host => host.hostId === 'local')?.threadCount).toBe(1);
  recovered = true;
  expect((await desktop.listHosts()).hosts.find(host => host.hostId === 'local')?.threadCount).toBe(2);
});

it('treats successful empty app inventory as reachable when CDP is offline', async () => {
  const desktop = facade([], {}, async () => offline());
  expect(await desktop.listThreads()).toMatchObject({ backend: 'app-server', threads: [], nextCursor: null });
  expect(await desktop.listHosts()).toMatchObject({ backend: 'app-server', modelProviders: [] });
});

it('still rejects when app-server, CDP and remote inventory are unavailable', async () => {
  await expect(facade([], { listThreads: async () => { throw new Error('app offline'); } }, async () => offline())
    .listThreads()).rejects.toMatchObject({ code: 'CDP_UNREACHABLE' });
});

it('keeps managed zero-thread hosts when offline and refreshes after source recovery', async () => {
  let recovered = false;
  const desktop = facade([], {
    listThreads: async () => {
      if (!recovered) throw new Error('app offline');
      return { backend: 'app-server', limit: 200, threads: [row('recovered')] };
    },
    listHosts: () => [{ hostId: 'managed-empty', hostName: null, location: 'remote', threadCount: 0 }],
  }, async () => offline());
  const result = await desktop.listHosts();
  expect(result.hosts).toEqual([{ hostId: 'managed-empty', hostName: null, location: 'remote', threadCount: 0 }]);
  expect(result.warnings).toContain('App-server list failed: app offline');
  recovered = true;
  expect((await desktop.listHosts()).hosts).toContainEqual(expect.objectContaining({ hostId: 'local', threadCount: 1 }));
});

it('returns an empty filtered list when only another remote host has threads', async () => {
  const result = await facade([], {
    listThreads: async () => { throw new Error('app offline'); },
    listRemoteThreads: () => [{ ...row('remote'), location: 'remote', hostId: 'remote', hostName: null }],
  }, async () => offline()).listThreads({ host: 'local' });
  expect(result).toMatchObject({ backend: 'remote-state', threads: [] });
});

it('matches complete remote and CDP metadata before compacting page output', async () => {
  for (const field of ['title', 'preview', 'project', 'hostName'] as const) {
    const full = 'x'.repeat(5000) + ' unique-tail';
    const remote = { ...row('remote'), location: 'remote' as const, hostId: 'remote', hostName: null, [field]: full };
    const sidebar = { ...row('sidebar'), location: 'remote' as const, hostId: 'sidebar-host', [field]: full };
    const result = await facade([sidebar], { listRemoteThreads: () => [remote] }).searchThreads({ query: 'unique-tail' });
    expect(result.threads.map(thread => thread.threadId).sort()).toEqual(['local:remote', 'local:sidebar']);
    expect(result.threads.every(thread => (thread[field]?.length ?? 0) < full.length)).toBe(true);
  }
});

it('lets the Node scorer choose a later selected and pinned DOM duplicate', async () => {
  const rows = [false, true].map(selected => ({ parentElement: null, getAttribute: (key: string) => ({
    'data-app-action-sidebar-thread-id': 'local:duplicate',
    'data-app-action-sidebar-thread-title': 'duplicate',
    'data-app-action-sidebar-thread-selected': String(selected),
    'data-app-action-sidebar-thread-pinned': String(selected),
  })[key] ?? null }));
  const extracted = new Function('document', `return ${LIST_THREADS_EXPRESSION}`)({ querySelectorAll: () => rows });
  const result = await listThreadsFromDom({ evaluate: async () => extracted } as never, 'fixture');
  expect(result).toMatchObject([{ threadId: 'local:duplicate', selected: true, pinned: true }]);
});

it('gives MCP open and send enough render time for the schema maximum', () => {
  expect(openThreadSchema.parse({ threadId: 'fixture' }).openTimeoutMs).toBe(90_000);
  for (const [tool, input] of [[openTool, { threadId: 'fixture' }], [sendTool, { text: 'fixture only' }]] as const) {
    const schema = tool === openTool ? openThreadSchema : sendSchema;
    const maxWait = schema.parse({ ...input, openTimeoutMs: 600_000 }).openTimeoutMs;
    expect(tool.render?.maxElapsedMs).toBe(660_000);
    let now = 0;
    const sequence = createAgentRenderEventSequence(tool.render, () => now);
    now = maxWait + 30_000;
    expect(() => sequence.emit({ type: 'progress', completed: 1 })).not.toThrow();
    now = 660_001;
    expect(() => sequence.emit({ type: 'progress', completed: 1 })).toThrow('Agent render elapsed time exceeds 660000ms');
  }
});
