// Shapes mirrored from Calandria's lib/types.ts, the route handlers under app/api/, and
// lib/workCenter/compat.ts. Only the fields this client reads are listed.

export type Priority = "hi" | "med" | "lo";
export const PRIORITIES: Priority[] = ["hi", "med", "lo"];
export type Status = "not_started" | "in_progress" | "on_hold" | "done" | "cancelled";
export const STATUSES: Status[] = ["not_started", "in_progress", "on_hold", "done", "cancelled"];
export type MsgRole = "user" | "assistant" | "tool" | "system" | "session_break";

/** GET /api/version */
export interface VersionInfo {
  version: string;
  sha?: string;
  builtAt?: string;
  instanceName?: string | null;
}

/** GET /api/projects (array) and the head of GET /api/projects/[id]. */
export interface Project {
  id: string;
  name: string;
  repo_path: string;
  branch: string;
  default_agent: string;
  deprecated?: number;
  awaiting_count?: number;
  awaiting_count_exact?: boolean;
}

export interface Tag {
  id: string;
  project_id: string;
  name: string;
}

/** The task row (lib/types.ts Task), trimmed. */
export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string;
  priority: Priority;
  status: Status;
  suggested: number;
  agent: string;
  model: string | null;
  permission_mode: string | null;
  auto_start: number;
  started: number;
  running: number;
  awaiting_input: number;
  background_pending?: number;
  background_note?: string;
  worktree_path: string;
  work_branch: string;
  base_branch?: string;
  merged_at: number;
  pr_url: string;
  pr_number?: number;
  pr_state?: string;
  pr_checks?: string;
  withdrawn_reason?: string;
  generation?: number;
  updated_at?: number;
}

/** GET /api/tasks/[id] */
export interface TaskDetail extends Task {
  cost_usd?: number;
  depends_on?: string[];
  tag_ids?: string[];
  messages: Message[];
}

/** GET /api/projects/[id] */
export interface ProjectDetail extends Project {
  tasks: Task[];
  tags: Tag[];
}

/** One element of GET /api/tasks `tasks` (listAllTasksLite in lib/store.ts). */
export interface TaskLite {
  id: string;
  project_id: string;
  title: string;
  status: Status | string;
  running: number;
  awaiting_input: number;
  updated_at: number;
  project_name: string;
  tags: { name: string; color: string | null }[];
}

export interface Message {
  id: string;
  task_id?: string;
  generation: number;
  role: MsgRole;
  content: string;
  created_at: number;
}

export interface PendingMessage {
  id: string;
  content: string;
}

export interface AskOption {
  label: string;
  description?: string;
}
export interface AskQuestion {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: AskOption[];
}
export type AskAnswers = string[][];

export interface PermissionRequest {
  id: string;
  tool: string;
  kind?: "settings" | "environment";
  title: string;
  detail: string;
  description?: string;
  scope?: { label?: string; value?: string };
  privateInput?: { name?: boolean; value?: boolean; valueRequired?: boolean };
  expiresAt: number;
}
export type PermissionDecision = "allow_once" | "allow_always" | "deny";
export interface PermissionOutcome {
  decision: PermissionDecision;
  auto?: boolean;
  reason?: string;
  note?: string;
}

/** The JSON stored in a role "tool" message (lib/types.ts ToolData). */
export interface ToolData {
  title: string;
  name?: string;
  detail?: string;
  result?: string;
  isError?: boolean;
  ask?: { id: string; questions: AskQuestion[]; answers?: AskAnswers; dismissed?: unknown };
  permission?: { request: PermissionRequest; outcome?: PermissionOutcome };
}

/** Per-task SSE frames from GET /api/tasks/[id]/messages (TaskStreamEvent). */
export type TaskEvent =
  | { type: "snapshot"; messages: Message[]; pending: PendingMessage[]; running: boolean }
  | { type: "user"; content: string; msgId?: string }
  | { type: "queued"; msgId: string; content: string }
  | { type: "dequeued"; msgId: string }
  | { type: "assistant"; content: string }
  | { type: "assistant_delta"; id: string; kind: "assistant" | "reasoning"; delta: string }
  | { type: "tool"; id: string; name?: string; title: string; detail?: string }
  | { type: "tool_result"; id: string; content: string; isError: boolean }
  | { type: "tool_output_delta"; id: string; delta: string }
  | { type: "ask"; id: string; questions: AskQuestion[] }
  | { type: "ask_answered"; id: string; answers?: AskAnswers }
  | { type: "ask_dismissed"; id: string }
  | { type: "permission"; request: PermissionRequest }
  | { type: "permission_decided"; id: string; outcome: PermissionOutcome }
  | { type: "permission_denied"; id: string; tool: string; reason?: string }
  | { type: "notice"; content: string }
  | { type: "error"; content: string }
  | { type: "background_pending"; note: string }
  | { type: "background_resumed"; status: string; summary: string }
  | { type: "done"; sessionId: string | null }
  | { type: "turn_end" }
  | { type: string; [k: string]: unknown };

/** Global SSE frames from GET /api/events (GlobalWireEvent). */
export interface GlobalTaskEvent {
  type: "task";
  event: string;
  taskId: string;
  projectId: string;
  running: boolean;
  awaiting_input: boolean;
  status: Status;
  background_pending?: boolean;
  background_note?: string;
  awaiting_count?: number;
}
export type GlobalEvent = GlobalTaskEvent | { type: string; [k: string]: unknown };

/** GET /api/needs-you rows (NeedsYouRow in lib/workCenter/compat.ts). */
export interface NeedsYouRow {
  id: string;
  project_id: string;
  title: string;
  project_name: string;
  waiting_since: number;
  reason: "ci" | "input";
  pr_number?: number;
  pr_url?: string;
}

export interface Runbook {
  id: string;
  project_id: string;
  name: string;
  description: string;
  agent: string;
  recipe_revision: number;
  agent_edit_revision: number;
  reviewed_agent_edit_revision: number;
  last_run: { id: string; title: string; status: string; created_at: number } | null;
}

export interface Schedule {
  id: string;
  project_id: string;
  name: string;
  days_mask: number;
  time_of_day: string;
  timezone: string;
  enabled: number;
  once_date: string;
  next_fire_at: number;
  last_run?: { status?: string; scheduled_for?: number } | null;
}

/** GET /api/tasks/[id]/move and GET /api/tasks/move (DiscardPreview in lib/taskMove.ts). */
export interface DiscardPreview {
  has_worktree: boolean;
  safe: boolean;
  dirty: boolean;
  ahead: number | null;
  reason: string | null;
  branch: string;
}

export interface MergeResult {
  ok: boolean;
  targetBranch?: string;
  alreadyMerged?: boolean;
  conflicts?: string[];
  error?: string;
  additions?: number;
  deletions?: number;
  dirty?: { code: string; path: string }[];
}

export interface PrResult {
  ok: boolean;
  url?: string;
  existing?: boolean;
  error?: string;
  detail?: string;
  editError?: string;
}

/** The sidecar the server writes beside its database (lib/db-lock.mjs). */
export interface LockSidecar {
  pid: number;
  host: string;
  startedAt?: number;
  url?: string;
}
