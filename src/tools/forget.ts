import type { AuthContext, ForgetResult } from '../types.js';
import { forgetMemories, forgetSchema } from '../memory-lifecycle.js';

export { forgetSchema };

export async function memoryForget(input: unknown, auth: AuthContext): Promise<ForgetResult> {
  return forgetMemories(input, auth);
}
