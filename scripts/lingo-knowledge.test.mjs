import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queryLingo } from './lingo-knowledge.mjs';

const config = {
  profile: 'botCow', identity: 'user', repo_id: 'repo-1', repo_name: '词典',
  required_scope: 'baike:entity:readonly', read_only: true
};

function reply(payload, status = 0) {
  return () => ({ status, stdout: status === 0 ? JSON.stringify(payload) : '',
    stderr: status === 0 ? '' : JSON.stringify(payload), error: null });
}

test('Lingo adapter rejects operations outside the read contract', () => {
  for (const args of [[], ['list'], ['search', '--query'], ['search', '--query', 'x', '--limit', '101'], null]) {
    assert.equal(queryLingo(args, { config, runner: reply({}) }).error_code, 'lingo_arguments_invalid');
  }
});

test('Lingo status verifies the configured repository', () => {
  const result = queryLingo(['status'], { config, runner: reply({ ok: true, data: { items: [
    { id: 'repo-1', name: '基础术语' }
  ] } }) });
  assert.equal(result.ok, true);
  assert.deepEqual(result.repo, { id: 'repo-1', name: '基础术语' });
  assert.equal(result.read_only, true);
});

test('Lingo search returns compact terminology without member identifiers', () => {
  const runner = (command, args) => {
    assert.equal(args[0], 'api');
    assert.equal(args[1], 'POST');
    assert.equal(args[2], '/open-apis/lingo/v1/entities/search');
    assert.equal(JSON.parse(args[4]).repo_id, 'repo-1');
    return { status: 0, stdout: JSON.stringify({ ok: true, data: { entities: [{
      id: 'entry-1', main_keys: [{ key: 'FTE' }], aliases: [{ key: '首次体验' }],
      description: '基础释义', creator: 'private-user-id',
      related_meta: { users: [{ id: 'private-user-id' }], docs: [{ title: '说明', url: 'https://example.test/doc' }] }
    }] } }), stderr: '', error: null };
  };
  const result = queryLingo(['search', '--query', 'FTE', '--limit', '5'], { config, runner });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].names[0], 'FTE');
  assert.equal(JSON.stringify(result).includes('private-user-id'), false);
});

test('Lingo missing scope is a stable blocked result', () => {
  const result = queryLingo(['status'], { config, runner: reply({ ok: false, error: {
    type: 'authorization', subtype: 'missing_scope', code: 99991679
  } }, 1) });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'lingo_read_permission_missing');
  assert.equal(result.required_scope, 'baike:entity:readonly');
  assert.equal(result.next_step, 'enable_app_scope_then_reauthorize_user');
});
