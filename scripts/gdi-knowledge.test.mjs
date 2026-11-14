import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queryGdi } from './gdi-knowledge.mjs';

test('GDI adapter rejects operations outside its read contract', () => {
  for (const args of [[], ['install'], ['read', 42], null]) {
    assert.equal(queryGdi(args).error_code, 'gdi_arguments_invalid');
  }
});

test('local GDI integration returns real sources and rejects private files', {skip: process.env.BOTCOW_GDI_INTEGRATION !== '1'}, () => {
  const status = queryGdi(['status']);
  assert.equal(status.ok, true);
  assert.equal(status.project, 'dobe');
  assert.equal(status.read_only, true);
  assert.equal(status.providers.knowledge, 'blocked_provider');
  const search = queryGdi(['search', '--query', '文本需求', '--limit', '1']);
  assert.equal(search.ok, true);
  assert.equal(search.returned, 1);
  const source = search.results[0];
  const read = queryGdi(['read', '--path', source.path, '--start', String(source.line_start), '--lines', '2']);
  assert.equal(read.ok, true);
  assert.equal(read.sha256, source.sha256);
  const denied = queryGdi(['read', '--path', 'tasks/private.md']);
  assert.equal(denied.ok, false);
  assert.equal(denied.error_code, 'document_not_published');
});
