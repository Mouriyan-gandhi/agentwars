"use client";

import { useEffect, useRef, useState } from "react";

export type Category = {
  value: string;
  label: string;
  hint: string;
};

type UploadedImage = { url: string; mime: string };
type UploadedAudio = { url: string; mime: string; durationSec: number };

type Props = {
  title: string;
  subtitle?: string;
  categories: Category[];
  // POST payload will include { source, order_code (if set), issue_category, raw_input, image_url, audio_url, input_type }
  source: "rider_report" | "customer_complaint";
  orderCode?: string;
  // Customer complaints need the email for ownership verification.
  customerEmail?: string;
  onFiled: (incidentId: string) => void;
  onCancel?: () => void;
};

export default function IssueReporter({
  title,
  subtitle,
  categories,
  source,
  orderCode,
  customerEmail,
  onFiled,
  onCancel,
}: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [category, setCategory] = useState<Category | null>(null);
  const [customTitle, setCustomTitle] = useState("");
  const [notifyEmail, setNotifyEmail] = useState("");
  const [text, setText] = useState("");
  const [img, setImg] = useState<UploadedImage | null>(null);
  const [audio, setAudio] = useState<UploadedAudio | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordSecs, setRecordSecs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const audioChunks = useRef<Blob[]>([]);
  const recordStart = useRef<number>(0);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (tickTimer.current) clearInterval(tickTimer.current);
      try {
        mediaRecorder.current?.stop();
      } catch {}
    };
  }, []);

  async function startRecording() {
    setErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimePreference = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
      const mimeType =
        mimePreference.find((m) => MediaRecorder.isTypeSupported(m)) || "";
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      audioChunks.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.current.push(e.data);
      };
      rec.onstop = async () => {
        const effectiveMime = rec.mimeType || "audio/webm";
        const blob = new Blob(audioChunks.current, { type: effectiveMime });
        const duration = Math.round((Date.now() - recordStart.current) / 1000);
        // Immediately stop all tracks to release the mic.
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        if (tickTimer.current) clearInterval(tickTimer.current);
        await uploadAudio(blob, effectiveMime, duration);
      };
      rec.start();
      mediaRecorder.current = rec;
      recordStart.current = Date.now();
      setRecordSecs(0);
      tickTimer.current = setInterval(() => {
        setRecordSecs(Math.round((Date.now() - recordStart.current) / 1000));
      }, 500);
      setRecording(true);
    } catch (e) {
      setErr(
        e instanceof Error
          ? `Microphone access denied: ${e.message}`
          : "Microphone access denied.",
      );
    }
  }

  function stopRecording() {
    try {
      mediaRecorder.current?.stop();
    } catch {}
  }

  async function uploadAudio(blob: Blob, mime: string, durationSec: number) {
    try {
      const fd = new FormData();
      fd.append("file", blob, "voice-note.webm");
      fd.append("kind", "audio");
      const res = await fetch("/api/uploads", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Upload failed");
      setAudio({ url: json.url, mime: json.mime || mime, durationSec });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function uploadImage(file: File) {
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", "image");
      const res = await fetch("/api/uploads", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Upload failed");
      setImg({ url: json.url, mime: json.mime || file.type });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const input_type = audio ? "audio" : img ? "image" : "text";
      const body: Record<string, unknown> = {
        input_type,
        source,
        issue_category: category?.value,
        raw_input: text.trim() || null,
      };
      if (orderCode) body.order_code = orderCode;
      if (customerEmail) body.customer_email = customerEmail;
      if (img) body.image_url = img.url;
      if (audio) body.audio_url = audio.url;
      if (category?.value === "other" && customTitle.trim()) {
        body.custom_issue_title = customTitle.trim();
      }
      if (notifyEmail.trim()) body.notify_email = notifyEmail.trim();

      const res = await fetch("/api/incidents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to file incident");
      onFiled(json.incident.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const otherNeedsTitle = category?.value === "other" && customTitle.trim().length === 0;
  const canSubmit =
    !!category && !otherNeedsTitle && (text.trim().length > 0 || !!img || !!audio);

  return (
    <div className="rounded-[40px] bg-pumice p-8">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-heading uppercase">{title}</h3>
          {subtitle && <p className="mt-1 text-body-sm text-obsidian/70">{subtitle}</p>}
        </div>
        {onCancel && (
          <button type="button" onClick={onCancel} className="btn-ghost text-sm">
            Close
          </button>
        )}
      </div>

      {/* step indicator */}
      <div className="mb-5 flex items-center gap-3 text-caption text-obsidian/60">
        <span className={step === 1 ? "font-medium text-obsidian" : ""}>1. Pick issue</span>
        <span>→</span>
        <span className={step === 2 ? "font-medium text-obsidian" : ""}>2. Add details</span>
      </div>

      {step === 1 && (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            {categories.map((c) => (
              <button
                key={c.value}
                onClick={() => {
                  setCategory(c);
                  setStep(2);
                }}
                className="rounded-[24px] bg-limestone p-4 text-left hover:bg-obsidian/5"
              >
                <div className="font-medium">{c.label}</div>
                <div className="mt-1 text-caption text-obsidian/60">{c.hint}</div>
              </button>
            ))}
          </div>
        </>
      )}

      {step === 2 && category && (
        <>
          <div className="mb-5 flex items-center gap-3">
            <button
              onClick={() => setStep(1)}
              className="btn-ghost text-caption"
              type="button"
            >
              ← Change
            </button>
            <span className="tag">{category.label}</span>
          </div>

          {category.value === "other" && (
            <>
              <label className="mb-2 block text-caption uppercase tracking-wide text-obsidian/60">
                Name the issue (your own title) <span className="text-ember">*</span>
              </label>
              <input
                value={customTitle}
                onChange={(e) => setCustomTitle(e.target.value)}
                className="input mb-4"
                placeholder="e.g. Lift is broken, I'm stuck on floor 7"
                maxLength={120}
              />
            </>
          )}

          <label className="mb-2 block text-caption uppercase tracking-wide text-obsidian/60">
            Describe what happened (optional if you record or upload)
          </label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            className="textarea mb-4"
            placeholder={`e.g. ${category.hint}`}
          />

          <label className="mb-2 block text-caption uppercase tracking-wide text-obsidian/60">
            Also send this issue to (optional email)
          </label>
          <input
            type="email"
            value={notifyEmail}
            onChange={(e) => setNotifyEmail(e.target.value)}
            className="input mb-4"
            placeholder="supervisor@company.com"
          />

          <div className="mb-4 grid gap-4 md:grid-cols-2">
            {/* voice */}
            <div className="rounded-[24px] bg-limestone p-4">
              <div className="text-caption uppercase tracking-wide text-obsidian/60">
                Voice note
              </div>
              {audio ? (
                <div className="mt-2 flex items-center gap-3">
                  <audio controls src={audio.url} className="flex-1" />
                  <button
                    type="button"
                    onClick={() => setAudio(null)}
                    className="btn-ghost text-caption"
                  >
                    Remove
                  </button>
                </div>
              ) : recording ? (
                <div className="mt-2 flex items-center gap-3">
                  <div className="flex-1 text-body-sm text-obsidian/80">
                    ● Recording… {recordSecs}s
                  </div>
                  <button onClick={stopRecording} className="btn-primary text-sm" type="button">
                    Stop
                  </button>
                </div>
              ) : (
                <button
                  onClick={startRecording}
                  className="btn-secondary mt-2 text-sm"
                  type="button"
                >
                  🎙 Record
                </button>
              )}
              <div className="mt-2 text-caption text-obsidian/50">
                Gemini will transcribe and classify in one call.
              </div>
            </div>

            {/* image */}
            <div className="rounded-[24px] bg-limestone p-4">
              <div className="text-caption uppercase tracking-wide text-obsidian/60">
                Photo
              </div>
              {img ? (
                <div className="mt-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.url} alt="uploaded" className="max-h-32 rounded-[16px]" />
                  <button
                    type="button"
                    onClick={() => setImg(null)}
                    className="btn-ghost mt-2 text-caption"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <label className="btn-secondary mt-2 inline-flex cursor-pointer text-sm">
                  📷 Upload photo
                  <input
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) uploadImage(f);
                    }}
                  />
                </label>
              )}
              <div className="mt-2 text-caption text-obsidian/50">
                Gemini vision will read the scene.
              </div>
            </div>
          </div>

          {err && (
            <div className="mb-4 rounded-[24px] bg-ember/10 p-4 text-body-sm text-ember">
              {err}
            </div>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={submit}
              disabled={!canSubmit || busy}
              className="btn-primary disabled:opacity-50"
            >
              {busy ? "Filing…" : "File incident →"}
            </button>
            {onCancel && (
              <button onClick={onCancel} type="button" className="btn-secondary">
                Cancel
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export const RIDER_CATEGORIES: Category[] = [
  { value: "cant_find_address", label: "Can't find the address", hint: "Landmarks don't match, no building number." },
  { value: "access_blocked", label: "Access blocked", hint: "Gate shut, lift broken, building closed." },
  { value: "customer_unreachable", label: "Customer unreachable", hint: "Not picking up calls or opening the door." },
  { value: "customer_refused", label: "Customer refused delivery", hint: "They told me to take it back." },
  { value: "parcel_damaged_transit", label: "Parcel damaged in transit", hint: "I noticed the box is torn before dropping off." },
  { value: "vehicle_personal_issue", label: "Vehicle / personal issue", hint: "Breakdown, injury, running late." },
  { value: "weather_safety", label: "Weather / safety", hint: "Flooded road, protest, unsafe area." },
  { value: "other", label: "Something else", hint: "Describe it in the next step." },
];

export const CUSTOMER_CATEGORIES: Category[] = [
  { value: "not_delivered", label: "Still haven't received it", hint: "Deadline passed, no delivery." },
  { value: "arrived_damaged", label: "Arrived damaged", hint: "Package or contents are broken." },
  { value: "wrong_item", label: "Wrong item delivered", hint: "Received something different." },
  { value: "no_attempt_notified", label: "Rider never attempted", hint: "No call, no SMS, no knock." },
  { value: "reschedule_address_change", label: "Change address / reschedule", hint: "I need a different time or place." },
  { value: "other", label: "Something else", hint: "Describe it in the next step." },
];
