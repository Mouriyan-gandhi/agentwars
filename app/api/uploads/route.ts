import { NextRequest, NextResponse } from "next/server";
import { uploadBlob, extensionForMime } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 60;

// multipart/form-data: field "file" + "kind" ("image" | "audio")
export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }
  const file = form.get("file");
  const kindRaw = form.get("kind");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file field missing" }, { status: 400 });
  }
  const kind: "image" | "audio" = kindRaw === "audio" ? "audio" : "image";

  if (file.size > 20 * 1024 * 1024) {
    return NextResponse.json({ error: "file too large (>20MB)" }, { status: 413 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const mime = file.type || (kind === "audio" ? "audio/webm" : "image/jpeg");

  try {
    const { path, signedUrl } = await uploadBlob({
      kind,
      mimeType: mime,
      bytes,
      extension: extensionForMime(mime),
    });
    return NextResponse.json({ ok: true, path, url: signedUrl, mime });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
