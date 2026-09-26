import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isDirectExecution(moduleUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvEntry);
  } catch {
    return false;
  }
}
