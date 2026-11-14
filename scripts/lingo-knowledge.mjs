import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(root, 'config', 'lingo-knowledge.json');

function cliExecutable() {
  if (process.env.LARK_CLI_EXE) return process.env.LARK_CLI_EXE;
  if (process.platform === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, 'npm', 'node_modules', '@larksuite', 'cli', 'bin', 'lark-cli.exe');
  }
  return 'lark-cli';
}

function readConfig() {
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

function parseEnvelope(result) {
  for (const body of [result.stdout, result.stderr]) {
    if (!body?.trim()) continue;
    try { return JSON.parse(body); } catch { /* try the other stream */ }
  }
  return null;
}

function permissionUrl(scope, appId) {
  return appId ? `https://open.feishu.cn/page/scope-apply?clientID=${encodeURIComponent(appId)}&scopes=${encodeURIComponent(scope)}` : 'https://open.feishu.cn/app';
}

function blocked(config, envelope, fallback = 'lingo_query_failed') {
  const error = envelope?.error ?? {};
  const missing = error.subtype === 'missing_scope' || error.subtype === 'app_scope_not_applied';
  return {
    schema_version: 1,
    ok: false,
    status: 'blocked',
    source: 'feishu_lingo',
    repo_id: config.repo_id,
    read_only: true,
    error_code: missing ? 'lingo_read_permission_missing' : fallback,
    retryable: false,
    ...(missing ? {
      required_scope: config.required_scope,
      permission_url: error.console_url ?? permissionUrl(config.required_scope, config.app_id),
      next_step: 'enable_app_scope_then_reauthorize_user'
    } : {}),
    upstream: {
      type: error.type ?? null,
      subtype: error.subtype ?? null,
      code: typeof error.code === 'number' ? error.code : null
    }
  };
}

function callLingo(config, method, path, { params, data } = {}, runner = spawnSync) {
  const args = ['api', method, path];
  if (params) args.push('--params', JSON.stringify(params));
  if (data) args.push('--data', JSON.stringify(data));
  args.push('--profile', config.profile, '--as', config.identity, '--format', 'json');
  const result = runner(cliExecutable(), args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: 20000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1'
    }
  });
  if (result.error) return { ok: false, result, envelope: null };
  const envelope = parseEnvelope(result);
  return { ok: result.status === 0 && envelope?.ok === true, result, envelope };
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function compactEntity(entity) {
  const resources = entity.related_meta ?? {};
  return {
    id: entity.id,
    names: (entity.main_keys ?? []).map(item => item.key).filter(Boolean),
    aliases: (entity.aliases ?? []).map(item => item.key).filter(Boolean),
    description: entity.description ?? '',
    rich_text: entity.rich_text ?? '',
    related_docs: (resources.docs ?? []).map(({ title, url }) => ({ title, url })),
    related_links: (resources.links ?? []).map(({ title, url }) => ({ title, url })),
    update_time: entity.update_time ?? null
  };
}

export function queryLingo(args, options = {}) {
  const config = options.config ?? readConfig();
  const runner = options.runner ?? spawnSync;
  if (!Array.isArray(args) || !['status', 'search'].includes(args[0]) ||
      args.some(value => typeof value !== 'string')) {
    return { schema_version: 1, ok: false, status: 'blocked', source: 'feishu_lingo',
      error_code: 'lingo_arguments_invalid', retryable: false };
  }

  if (args[0] === 'status') {
    if (args.length !== 1) return { schema_version: 1, ok: false, status: 'blocked', source: 'feishu_lingo',
      error_code: 'lingo_arguments_invalid', retryable: false };
    const call = callLingo(config, 'GET', '/open-apis/lingo/v1/repos', {}, runner);
    if (!call.ok) return blocked(config, call.envelope, call.result.error ? 'lingo_cli_unavailable' : 'lingo_status_failed');
    const repos = call.envelope.data?.items ?? [];
    const repo = repos.find(item => item.id === config.repo_id);
    if (!repo) return { schema_version: 1, ok: false, status: 'blocked', source: 'feishu_lingo',
      repo_id: config.repo_id, read_only: true, error_code: 'lingo_repo_not_visible', retryable: false };
    return { schema_version: 1, ok: true, status: 'ready', source: 'feishu_lingo', read_only: true,
      identity: config.identity, repo: { id: repo.id, name: repo.name } };
  }

  const query = option(args, '--query');
  const limitRaw = option(args, '--limit') ?? '10';
  const limit = Number.parseInt(limitRaw, 10);
  if (!query || query.length > 100 || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
      args.length !== (args.includes('--limit') ? 5 : 3)) {
    return { schema_version: 1, ok: false, status: 'blocked', source: 'feishu_lingo',
      error_code: 'lingo_arguments_invalid', retryable: false };
  }
  const call = callLingo(config, 'POST', '/open-apis/lingo/v1/entities/search', {
    params: { repo_id: config.repo_id, page_size: limit, user_id_type: 'open_id' }, data: { query }
  }, runner);
  if (!call.ok) return blocked(config, call.envelope, call.result.error ? 'lingo_cli_unavailable' : 'lingo_search_failed');
  const data = call.envelope.data ?? {};
  return {
    schema_version: 1,
    ok: true,
    status: 'ready',
    source: 'feishu_lingo',
    repo_id: config.repo_id,
    read_only: true,
    query,
    returned: (data.entities ?? []).length,
    has_more: data.has_more === true,
    page_token: data.page_token ?? null,
    results: (data.entities ?? []).map(compactEntity)
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = queryLingo(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 2;
}
