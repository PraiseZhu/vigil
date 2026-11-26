import { spawnSync } from 'node:child_process';

function configuredCommand(profile, device, env) {
  const commands = profile?.presence?.commands ?? profile?.presence;
  if (commands && typeof commands === 'object' && !Array.isArray(commands)
    && typeof commands[device] === 'string') return commands[device];
  if (typeof profile?.presenceCommand === 'string') return profile.presenceCommand;
  if (typeof env?.STEWARD_PRESENCE_COMMAND === 'string') return env.STEWARD_PRESENCE_COMMAND;
  return null;
}

export function probePresence({ device, command, profile, env = process.env, run = spawnSync, timeoutMs = 5_000 } = {}) {
  if (typeof device !== 'string' || !device) return false;
  const selected = command ?? configuredCommand(profile, device, env);
  if (typeof selected !== 'string' || !selected.trim()) return false;
  const expanded = selected.replaceAll('{device}', device);
  const result = run('/bin/sh', ['-c', expanded], { stdio: 'ignore', timeout: timeoutMs, windowsHide: true });
  return result?.error === undefined && result?.status === 0;
}

export const isPresent = probePresence;
