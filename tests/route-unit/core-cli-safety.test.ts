import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from '@rstest/core';
import { invokeCli } from 'agent-bundle/test';
import { createAgent, createGroup, listRecords } from '../../src/core/store.js';

it('roster mutation receipts strip terminal controls and JSON retains original names', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gbot-cli-controls-'));
  const osc = '\x1b]52;c;RkFLRQ==\x07';
  try {
    const a = createAgent(root, { name: `Alpha${osc}` });
    const b = createAgent(root, { name: 'Beta' });
    const c = createAgent(root, { name: 'Gamma' });
    const group = createGroup(root, { name: `Group${osc}`, memberIds: [a.id, b.id] });
    const commands = [
      ['bots', 'create', '--name', `New${osc}`],
      ['bots', 'update', a.id, '--description', 'updated'],
      ['groups', 'create', '--name', `NewGroup${osc}`, '--member', a.id, '--member', c.id],
      ['groups', 'update', group.id, '--description', 'updated'],
      ['groups', 'add', group.id, c.id],
      ['groups', 'remove', group.id, c.id],
      ['groups', 'set', group.id, '--member', a.id],
      ['groups', 'delete', group.id],
      ['bots', 'delete', a.id],
    ];
    for (const args of commands) {
      const result = await invokeCli([...args, '--files', '--dir', root]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    }
    const remaining = listRecords(root).find(record => record.name === `New${osc}`);
    if (!remaining) throw new Error('Created bot is missing');
    const json = await invokeCli(['bots', 'get', remaining.id, '--files', '--dir', root, '--json']);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout).name).toBe(`New${osc}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
