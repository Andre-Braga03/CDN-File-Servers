import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "node:path";
import { randomBytes } from "node:crypto";




export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const formData = await req.formData();
  const file = formData.get("thumbnail");
  if (!(file instanceof File)) {
    throw new BadRequestError("Thumbnail file missing");
  }
  const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10MB
  const mediaType = file.type;
  
  if(file.size > MAX_UPLOAD_SIZE && !mediaType.startsWith("image/png")) {
    throw new BadRequestError("Invalid media type");
  }
  const data = await file.arrayBuffer();

  const video = await getVideo(cfg.db, videoId);
  if(!video) {
    throw new NotFoundError("Video not found");
  }
  if(video.userID !== userID) {
    throw new UserForbiddenError("Not the video owner");
  }

  if(mediaType !== "image/png" && mediaType !== "image/jpeg") {
    throw new BadRequestError("Invalid media type");
  }
  const extension = mediaType.split("/")[1];
  const randomName = randomBytes(32).toString("base64url");
  const filePath = path.join(cfg.assetsRoot, `${randomName}.${extension}`);
  await Bun.write(filePath, data);
  video.thumbnailURL = `http://localhost:${cfg.port}/assets/${randomName}.${extension}`;
  updateVideo(cfg.db, video);
  return respondWithJSON(200, video);
  }

