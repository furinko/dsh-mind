/** Storage migration only. This does not recognize, read or adapt any live platform. */
import { digest } from './kernel/text.js';
export const legacyConversationCursor = (state, spec, origin) => origin.version === undefined
  ? state.conversations[digest(spec.project + '\0' + spec.session + '\0qq-source-v1')] ?? -1 : -1;
