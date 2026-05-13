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
};

export async function runTask(taskId: string, options: TaskRunOptions = {}): Promise<void> {
  const task = await getTask(taskId);
  if (!task) return;

  try {
    await updateTask(taskId, { status: "running", error: null });

    const connection = task.connectionId ? await getConnection(task.connectionId) : null;
    const plannerInput = {
      question: task.question,
      startUrlHint: connection?.startUrl ?? options.startUrlHint
    };
    const plannerOptions = {
      apiKey: options.apiKey,
      llmProvider: options.llmProvider
    };
    const plan = options.screenshotFilePath
      ? await buildPlanFromScreenshot(plannerInput, options.screenshotFilePath, plannerOptions)
      : await buildPlan(plannerInput, plannerOptions);

    await updateTask(taskId, { planJson: JSON.stringify(plan, null, 2) });

    const result = await executePlan({
      plan: plan as Plan,
      taskId,
      storageState: task.connectionId
        ? await getConnectionState(task.connectionId)
        : undefined,
      manualAssist: options.manualAssist ?? false
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
    await updateTask(taskId, { status: "error", error: message });
  }
}
