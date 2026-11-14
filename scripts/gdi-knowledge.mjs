// DOBE-GDI is the single producer. No copied corpus, shell interpolation or remote calls.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const entry = process.env.GDI_KNOWLEDGE_ENTRY || 'D:\\example\\DobeGDI\\ai\\dobe_gdi\\local_knowledge.py';
export function queryGdi(args) {
  if (!Array.isArray(args) || !['status', 'search', 'read'].includes(args[0]) ||
      args.some(value => typeof value !== 'string')) {
    return { ok: false, status: 'blocked', error_code: 'gdi_arguments_invalid', retryable: false };
  }
  const result = spawnSync('py', ['-3', entry, ...args], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 15000,
    maxBuffer: 16384, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }
  });
  if (result.error) return { ok: false, status: 'blocked', error_code: 'gdi_query_unavailable', retryable: false };
  try {
    const payload = JSON.parse(result.stdout);
    if (payload.schema_version !== 1 || typeof payload.ok !== 'boolean' ||
        (result.status === 0) !== payload.ok ||
        (payload.ok && (payload.project !== 'dobe' || payload.read_only !== true))) {
      throw new Error('invalid contract');
    }
    return payload;
  } catch {
    return { ok: false, status: 'blocked', error_code: 'gdi_query_contract_invalid', retryable: false };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = queryGdi(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.ok ? 0 : 2;
}
