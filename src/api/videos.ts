import { unlink } from "node:fs/promises";
import path from "node:path";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { respondWithJSON } from "./json";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";


export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const MAX_UPLOAD_SIZE = 1 << 30 ; // 1GB
  const { videoId }= req.params as { videoId?: string };
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

  try{
    await Bun.write(tempPath, file);

    const s3File = cfg.s3Client.file(`${videoId}.mp4`, {
      bucket: cfg.s3Bucket,
      region: cfg.s3Region,
    });
    await s3File.write(Bun.file(tempPath), {type : file.type});
  } finally{
    await unlink(tempPath);
  }
  video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${videoId}.mp4`;
  await updateVideo(cfg.db, video);
 
  return respondWithJSON(200, video);
}
