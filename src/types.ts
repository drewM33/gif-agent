export type ConnectionRecord = {
  id: string;
  name: string;
  domain: string;
  startUrl: string;
  encryptedState: string;
  createdAt: string;
  updatedAt: string;
  /** Owner when created via extension/import; null for legacy rows. */
  userId: string | null;
};

export type TaskStatus = "queued" | "running" | "done" | "error";

export type TaskRecord = {
  id: string;
  question: string;
  connectionId: string | null;
  status: TaskStatus;
  planJson: string | null;
  outputUrl: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PlanStep =
  | { action: "navigate"; url: string; caption?: string }
  | { action: "click"; selector: string; caption?: string }
  | { action: "type"; selector: string; text: string; caption?: string }
  | { action: "hover"; selector: string; caption?: string }
  | { action: "highlight"; selector: string; caption?: string }
  | { action: "wait"; ms: number; caption?: string };

export type Plan = {
  startUrl: string;
  steps: PlanStep[];
};
