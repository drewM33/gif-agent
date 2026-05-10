import { spawn } from "node:child_process";

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", args, { stdio: "ignore" });

    ffmpeg.on("error", (error) => reject(error));
    ffmpeg.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
}

export async function videoToGif(input: {
  videoPath: string;
  outputGifPath: string;
  fps?: number;
}): Promise<void> {
  const fps = input.fps ?? 8;
  await runFfmpeg([
    "-y",
    "-i",
    input.videoPath,
    "-vf",
    `fps=${fps},scale=1280:-1:flags=lanczos`,
    "-loop",
    "0",
    input.outputGifPath
  ]);
}
