/**
 * The web app's daemon client. The shared, typed client lives in
 * `@workbench/client`; here we just bind it to the same origin (relative paths)
 * and re-export the response types so existing `../api.js` imports keep working.
 */
import { createClient } from '@workbench/client';

export type {
  AgentQuestion,
  AgentQuestionAnswer,
  AgentQuestionOption,
  AgentRun,
  AgentRunEvent,
  AgentRunStatus,
  AssetKind,
  ChangedFile,
  DemoAsset,
  GitStatus,
  TaskDetail,
} from '@workbench/client';

/** Same-origin client: the browser talks to the daemon at relative `/api/...`. */
export const api = createClient('');
