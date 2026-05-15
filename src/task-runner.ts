import path from "node:path";
import { getConnection, getTask, updateTask } from "./db";
import { videoToGif } from "./encoder";
import { executePlan } from "./executor";
import { getConnectionState } from "./connections";
import type { LlmProvider } from "./llm-provider";
import { buildPlan, buildPlanFromScreenshot } from "./planner";
import type { Plan } from "./types";

type TaskRunOptions = {
  manualAssist?: boolean;
  screenshotFilePath?: string;
  startUrlHint?: string;
  apiKey?: string;
  llmProvider?: LlmProvider;
  /**
   * Optional pre-computed plan (e.g. produced by /plan/preview).
   * When set, the planner is skipped and this plan is used directly.
   */
  prebuiltPlan?: Plan;
};

function isCaptchaActionRequired(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /captcha challenge detected|timed out waiting for manual captcha solve/i.test(message);
}

function isGifAgentHostingUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.includes("gif-agent");
  } catch {
    return false;
  }
}

export async function runTask(taskId: string, options: TaskRunOptions = {}): Promise<void> {
  const task = await getTask(taskId);
  if (!task) return;

  try {
    await updateTask(taskId, { status: "running", error: null });

    const connection = task.connectionId ? await getConnection(task.connectionId) : null;
    let startUrlHint = connection?.startUrl ?? options.startUrlHint;
    if (options.screenshotFilePath && startUrlHint && isGifAgentHostingUrl(startUrlHint)) {
      startUrlHint = undefined;
    }
    const plannerInput = {
      question: task.question,
      startUrlHint
    };
    const plannerOptions = {
      apiKey: options.apiKey,
      llmProvider: options.llmProvider
    };
    const plan = options.prebuiltPlan
      ? options.prebuiltPlan
      : options.screenshotFilePath
        ? await buildPlanFromScreenshot(plannerInput, options.screenshotFilePath, plannerOptions)
        : await buildPlan(plannerInput, plannerOptions);

    await updateTask(taskId, { planJson: JSON.stringify(plan, null, 2) });

    const result = await executePlan({
      plan: plan as Plan,
      taskId,
      storageState: task.connectionId
        ? await getConnectionState(task.connectionId)
        : undefined,
      manualAssist: options.manualAssist ?? false,
      selectorRepair: {
        apiKey: options.apiKey,
        llmProvider: options.llmProvider,
        taskGoal: task.question
      }
    });

    const gifPath = path.join("files", "recordings", taskId, "video.gif");
    await videoToGif({
      videoPath: result.recordedVideoPath,
      outputGifPath: gifPath
    });

    await updateTask(taskId, {
      status: "done",
      outputUrl: `/files/recordings/${taskId}/video.gif`
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown task failure.";
    if (isCaptchaActionRequired(error)) {
      await updateTask(taskId, { status: "needs_action", error: message });
      return;
    }
    await updateTask(taskId, { status: "error", error: message });
  }
}
