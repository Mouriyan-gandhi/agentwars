import { supabaseAdmin } from "./supabase";

const BUCKET = "incident-uploads";

let _bucketReady: Promise<void> | null = null;

async function ensureBucket(): Promise<void> {
  const admin = supabaseAdmin();
  const { data, error } = await admin.storage.getBucket(BUCKET);
  if (data) return;
  // Ignore "not found" error; create.
  if (error && !/not.*found/i.test(error.message)) throw new Error(error.message);
  const { error: createErr } = await admin.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: 20 * 1024 * 1024, // 20MB
  });
  if (createErr && !/already exists/i.test(createErr.message)) {
    throw new Error(`createBucket: ${createErr.message}`);
  }
}

function readyBucket(): Promise<void> {
  if (!_bucketReady) _bucketReady = ensureBucket();
  return _bucketReady;
}

export type UploadKind = "image" | "audio";

export async function uploadBlob(args: {
  kind: UploadKind;
  mimeType: string;
  bytes: Buffer;
  extension: string;
}): Promise<{ path: string; signedUrl: string }> {
  await readyBucket();
  const key = `${args.kind}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${args.extension}`;
  const admin = supabaseAdmin();

  const { error } = await admin.storage
    .from(BUCKET)
    .upload(key, args.bytes, { contentType: args.mimeType, upsert: false });
  if (error) throw new Error(`upload: ${error.message}`);

  // 7-day signed URL — plenty for the demo + for Gemini to fetch during analysis.
  const { data, error: signErr } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(key, 60 * 60 * 24 * 7);
  if (signErr || !data) throw new Error(`sign: ${signErr?.message ?? "no data"}`);

  return { path: key, signedUrl: data.signedUrl };
}

export function extensionForMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("webm")) return "webm";
  if (m.includes("mp4")) return "mp4";
  if (m.includes("mp3") || m.includes("mpeg")) return "mp3";
  if (m.includes("wav")) return "wav";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("png")) return "png";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("heic")) return "heic";
  return "bin";
}
