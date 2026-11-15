// 部署审计：只追加、不覆盖。写失败由调用方在快进前失败关闭。
import fs from 'node:fs';
import path from 'node:path';

export const AUDIT_SCHEMA = 'vigil-deploy-audit/v1';

export function defaultAuditLogPath(stateFile) {
  if (!stateFile) return null;
  return path.join(path.dirname(stateFile), 'deploy-ff-audit.jsonl');
}

export function appendDeployAudit(file, record) {
  if (!file) throw new Error('audit-log-missing');
  const payload = { schema: AUDIT_SCHEMA, ...record };
  const line = `${JSON.stringify(payload)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, line, { mode: 0o600 });
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`audit-log-unverified:${error.message || error}`);
  }
  const rows = text.split('\n').filter((row) => row.trim());
  if (!rows.length) throw new Error('audit-log-unverified');
  if (rows[rows.length - 1] !== JSON.stringify(payload)) throw new Error('audit-log-unverified');
  return payload;
}

export function readDeployAudit(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((row) => row.trim()).map((row) => JSON.parse(row));
}
