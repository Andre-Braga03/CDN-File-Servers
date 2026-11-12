import { unlink } from "node:fs/promises";
import path from "node:path";
import { getBearerToken, validateJWT } from "../auth";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { respondWithJSON } from "./json";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { getVideo, updateVideo } from "../db/videos";

// Returns the aspect ratio of a video file
export async function getVideoAspectRatio(filePath: string) : Promise<string> {
  const proc = Bun.spawn([
   "ffprobe",
   "-v",
   "error",
   "-select_streams",
   "v:0",
   "-show_entries",
   "stream=width,height",
   "-of",
   "json",
   filePath,
 ],
 { stdout: "pipe", stderr: "pipe" },
 );
 
 const stdoutText = await new Response(proc.stdout).text();
 const stderrText = await new Response(proc.stderr).text();
 const exitCode = await proc.exited;
 
 if(exitCode !== 0) {
   throw new Error( stderrText || "ffprobe failed");
 }
 
 const data = JSON.parse(stdoutText);
 const {width, height} = data.streams[0];
 const ratio = width / height;
 
 if(Math.abs(ratio - 16/9) < 0.01) {
   return "landscape";
 }
 
 if (Math.abs(ratio - 9 / 16) < 0.01) {
   return "portrait";
 }
 return "other";
 }


export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const MAX_UPLOAD_SIZE = 1 << 30 ; // 1GB
  const { videoId } = req.params as { videoId?: string };
  if(!videoId) {
    throw new BadRequestError("Invalid video ID");
  }
  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);
  
  const video = getVideo(cfg.db, videoId);
  if(!video) {
    throw new NotFoundError("Video not found");
  }
  if(video.userID !== userID){
    throw new UserForbiddenError("Not the video owner");
  }

  const formData = await req.formData();
  const file = formData.get("video");

  if(!(file instanceof File)) {
    throw new BadRequestError("Video file missing");
  }

  if(file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File exceeds upload limit");
  }

  if(file.type !== "video/mp4") {
    throw new BadRequestError("Invalid media type");
  }
 
  const tempPath = path.join("/tmp", `${videoId}.mp4`);
  let key = "";
  let processedPath = "";
  try{
    await Bun.write(tempPath, file);
    const aspectRatio = await getVideoAspectRatio(tempPath);
    key = `${aspectRatio}/${videoId}.mp4`;

    processedPath = await processVideoForFastStart(tempPath);
    const s3File = cfg.s3Client.file(key, {
      bucket: cfg.s3Bucket,
      region: cfg.s3Region,
    });
    await s3File.write(Bun.file(processedPath), {type : file.type});
  } finally{
    await unlink(tempPath);
    if(processedPath !== "") {
      await unlink(processedPath);
    }
  }
  const distribution = cfg.s3CfDistribution.replace(/\/$/, "");
  video.videoURL = `${distribution}/${key}`;
  await updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}

export async function processVideoForFastStart(inputFilePath: string) : Promise<string> {
  const outputFilePath = `${inputFilePath}.processed`;
  const proc =Bun.spawn([
    "ffmpeg",
    "-i",
    inputFilePath,
    "-movflags",
    "faststart",
    "-map_metadata",
    "0",
    "-codec",
    "copy",
    "-f",
    "mp4",
    outputFilePath,
  ], { stdout: "pipe", stderr: "pipe" });
  const stderrText = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if(exitCode !== 0) {
    throw new Error(stderrText || "ffmpeg failed");
  }

  return outputFilePath;
}
