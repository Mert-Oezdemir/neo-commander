import type { Mode } from '../config.js';
import type { Risk } from '../tools/types.js';

export const MODE_RISKS: Record<Mode, ReadonlySet<Risk>> = {
  readonly: new Set<Risk>(['read']),
  standard: new Set<Risk>(['read', 'write', 'exec']),
  full: new Set<Risk>(['read', 'write', 'exec', 'control']),
};

/** Engine (Desktop Commander) tools: name -> risk. Unknown engine tools default to 'exec'. */
export const ENGINE_RISK: Record<string, Risk> = {
  read_file: 'read', read_multiple_files: 'read', list_directory: 'read', get_file_info: 'read',
  start_search: 'read', get_more_search_results: 'read', stop_search: 'read', list_searches: 'read',
  list_processes: 'read', list_sessions: 'read', read_process_output: 'read', get_config: 'read',
  write_file: 'write', edit_block: 'write', create_directory: 'write', move_file: 'write', write_pdf: 'write',
  start_process: 'exec', interact_with_process: 'exec', kill_process: 'exec', force_terminate: 'exec',
};

/** Never advertised, never executed: we own config, history would leak, telemetry/feedback phones home. */
export const ENGINE_ALWAYS_DENIED: ReadonlySet<string> = new Set([
  'set_config_value', 'get_recent_tool_calls', 'get_usage_stats', 'give_feedback_to_desktop_commander',
]);

/** Which arguments of known engine tools are file-system paths (from upstream schemas.ts). */
export const ENGINE_PATH_ARGS: Record<string, string[]> = {
  read_file: ['path'], read_multiple_files: ['paths'], list_directory: ['path'], get_file_info: ['path'],
  start_search: ['path'], write_file: ['path'], edit_block: ['file_path'], create_directory: ['path'],
  move_file: ['source', 'destination'], write_pdf: ['path', 'sourcePdfPath', 'outputPath'],
};

/** Engine tools that recurse below their path argument (denied when it would reach the state dir). */
export const ENGINE_RECURSIVE_ARGS: Record<string, string[]> = { start_search: ['path'], list_directory: ['path'] };

const PATHISH = /^(path|paths|source|destination|directory|dir|cwd|outputPath|file|files|file_path|filePath|filepath|.*_path|.*Path|.*Paths|.*_dir|.*Dir|.*Directory)$/;

export function heuristicPathArgs(inputSchema: unknown): string[] {
  const props = (inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (!props || typeof props !== 'object') return [];
  return Object.keys(props).filter((k) => PATHISH.test(k));
}
