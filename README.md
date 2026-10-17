This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

# ParcelPilot — How to Use the Agent

This guide walks through installing the project, applying the database schema,
logging into each portal, and running the demo scenarios end-to-end. If you
want to understand *how* the system works, read `ARCHITECTURE.md`. This file
focuses on *what you click* and *what you'll see*.

---

## 1. Prerequisites

- Node.js 20+ and `npm`
- A free Supabase project — https://supabase.com
- A free Google AI Studio API key — https://aistudio.google.com/apikey
- A free Resend API key — https://resend.com

> **Resend caveat (unverified-domain mode):** when sending from
> `onboarding@resend.dev`, Resend only delivers to the email address the
> Resend account was created with. For the demo, make sure that email is
> what you seed as `PP-1001`'s `customer_email` (see `supabase/migrations/001_init.sql`).

---

## 2. Install and configure

```bash
git clone https://github.com/Mouriyan-gandhi/agentwars.git
cd agentwars
npm install
cp .env.example .env.local
```

Fill in `.env.local`:

- `NEXT_PUBLIC_SUPABASE_URL` and the two Supabase keys (from Project Settings → API)
- `GEMINI_API_KEY` (Google AI Studio)
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL` — leave as `ParcelPilot <onboarding@resend.dev>` for the demo
- `CUSTOMER_FORM_TOKEN_SECRET` — generate with `openssl rand -hex 32`

---

## 3. Create the database schema

In the Supabase dashboard, open **SQL Editor → New query** and run the three
migration files in order:

1. `supabase/migrations/001_init.sql` — core tables + seed orders and riders
2. `supabase/migrations/002_portals.sql` — users table + rider assignments
3. `supabase/migrations/003_feedback_and_sources.sql` — complaint source,
   categories, audio uploads, admin feedback table

**Important before running 001:** edit the first seeded order so
`customer_email` is the inbox where you want Resend to deliver demo emails
(the Resend account owner's email).

```sql
-- in 001_init.sql
('PP-1001', 'Caanush Gandhi', 'YOUR_RESEND_ACCOUNT_EMAIL@gmail.com', ...)
```

Supabase Storage requires nothing manual — the app creates its
`incident-uploads` bucket on the first file upload.

---

## 4. Start the dev server

```bash
npm run dev
```

Open **http://localhost:3000**. You'll land on the three-portal picker.

---

## 5. The three portals

### Landing page — `/`

- Hero and a card for each of the three actors.
- Shows demo credentials on every card so judges can log in without hunting.
- If you're already logged in, the landing redirects to your portal.

### Rider portal — `/rider`

**Login:** `arjun@parcelpilot.dev` / `rider123`
(also `priya@…` and `rohan@…` with the same password)

What you see:
- Your assigned orders, deadline-sorted
- Any recent incidents you've filed or are assigned to
- A `Live · updates every 3s` tag; the dashboard auto-refreshes

Filing an incident:
1. Click **Report issue** on an order card.
2. Pick a category chip: *Can't find address*, *Access blocked*,
   *Customer unreachable*, *Customer refused*, *Parcel damaged in transit*,
   *Vehicle / personal issue*, *Weather / safety*, or *Other*.
3. Add details via any combination:
   - Type a description
   - Click 🎙 **Record** to capture a voice note from your mic (browser
     prompts for permission once). Click **Stop** to end — the WebM is
     uploaded to Supabase Storage and queued for Gemini.
   - Click 📷 **Upload photo** to attach an image. Also uploaded to Storage.
4. Click **File incident →**. Within a few seconds you'll be redirected to
   `/rider/incidents/<id>` showing the agent's live progress.

### Customer portal — `/customer`

No login. The customer enters:
- Order code: e.g. `PP-1001`
- Email on the order: e.g. `gandhimouriyan1234@gmail.com`

What they see:
- Current order status + assigned rider name
- Any past incidents on the order
- A **Something's wrong — file a complaint** button

Filing a complaint uses the same two-step reporter as the rider, but with
customer-side categories: *Still haven't received it*, *Arrived damaged*,
*Wrong item*, *Rider never attempted*, *Change address / reschedule*, *Other*.

Customers also receive the clarification-form flow automatically when a
rider report says the agent needs more info. The email arrives from
`ParcelPilot <onboarding@resend.dev>` with a one-time link to
`/customer-form/<token>`.

### Admin portal — `/admin`

**Login:** `admin@parcelpilot.dev` / `admin123`

What you see on the dashboard:
- 4 stat cards: Open / Awaiting customer / Recovery actions / Verified
  resolutions (the last one is the Ember-filled feature card)
- Recent incidents table with status pills
- Orders & current rider assignments
- Rider fleet with availability

What you can do on an incident detail (`/admin/incidents/<id>`):
- See the raw rider or customer report (text, image preview, audio player)
- Read the Gemini decision: type, order, summary, missing information,
  recommended action, reasoning
- Read the full execution timeline (every state transition is a row)
- Give **feedback** on the agent's decision:
  - ✓ **Right call** — stored for analytics
  - ✗ **Wrong call → should have been X** — the correction is injected into
    every future Gemini call as a few-shot example (see §6 below)

---

## 6. Demo scenarios

The following three flows exercise every path in the system. Run them in
order on a fresh database for the cleanest demo.

### Scenario A — Rider needs the customer's help (address clarification)

1. Log in as **Arjun** → open **PP-1001** → **Report issue** →
   `Can't find address`.
2. Type something like *"At the main gate but I can't tell which building is
   3B — the address just says 'near the park'."* Click **File incident →**.
3. The incident detail page shows:
   - Agent action: `request_clarification` (status `awaiting_customer`)
   - An email was sent to the customer (visible in the "Customer
     communication" panel, with the Resend message id)
4. Open the email in your inbox. Click **Update delivery details**.
5. Fill in the clarified address + notes + phone. Submit.
6. Back in the admin dashboard, the incident flips to `resolved`. The order's
   `address` is now the one the customer typed. The rider dashboard shows the
   new address.

### Scenario B — Rider is physically unable to continue (reassignment)

1. Log in as **Arjun** → open **PP-1001** → **Report issue** →
   `Vehicle / personal issue`.
2. Type something like *"I twisted my ankle. Need someone else to take this."*
3. Agent decides `propose_reassignment`, picks the next available rider that
   isn't Arjun (Priya or Rohan), updates the order's `rider_id`, marks Arjun
   available again, marks the new rider busy, and resolves the incident.
4. Log in as the new rider in another tab (or incognito window) — the order
   appears on their dashboard within 3 seconds (polling).

### Scenario C — Customer complaint + admin feedback loop

1. In an incognito window, open `/customer` → look up **PP-1001** with the
   customer's email.
2. Click **Something's wrong** → `Arrived damaged` → describe briefly →
   **File incident →**.
3. The agent picks `offer_refund_or_reship` and marks the order `exception`.
4. In the admin tab, open the incident → click **✗ Wrong call** → type
   `verify_with_rider` in "What should the agent have done?" → add a short
   reason (e.g. *"Always verify with the rider first to rule out false
   claims"*) → **Submit correction →**.
5. File a second damaged complaint on another order (`PP-1002` with
   `meera.test@example.com`).
6. Open the new incident in admin. The agent now picks `verify_with_rider`
   — and the "analyze" log entry shows `used_feedback_examples: 1`.
   The agent learned from your one correction.

---

## 7. Common questions

**How do I reset the demo state?**
```sql
-- in Supabase SQL editor
delete from incidents;
update orders set status = 'out_for_delivery', address = '<original>' where order_code = 'PP-1001';
update riders set status = 'available';
```

**Why don't my emails arrive?**
Resend's `onboarding@resend.dev` only delivers to the Resend account owner's
email until you verify a domain at https://resend.com/domains. Edit the
`PP-1001` seed to use that address.

**Can I use a different Gemini model?**
Yes — set `GEMINI_MODEL` in `.env.local`. Any model that supports
`generateContent` with multimodal input (text / image / audio) will work.
`gemini-3.8-flash` is the current fast + free-tier option.

**Where does audio actually go?**
`MediaRecorder` → `POST /api/uploads` → Supabase Storage bucket
`incident-uploads/audio/<timestamp>.webm` → 7-day signed URL stored on the
incident → fetched server-side when Gemini runs → sent as `inlineData` in
base64.

**Does the agent ever call out to the ops team automatically?**
No. Admins pull the dashboard; nothing is pushed. For a production deployment
you'd add a Slack/email notification when an incident hits `escalated`.

**Is the auth production-ready?**
No. Passwords are stored in plaintext in the `users` table for demo
convenience. Replace with bcrypt / Supabase Auth magic links before shipping.

---

## 8. One-shot verification (curl)

If you want to confirm the full loop works without clicking through the UI:

```bash
# log in as rider
curl -s -c arjun.cookies -X POST http://localhost:3000/api/auth/login \
  -H "content-type: application/json" \
  -d '{"email":"arjun@parcelpilot.dev","password":"rider123","role":"rider"}'

# file a structured incident
curl -s -b arjun.cookies -X POST http://localhost:3000/api/incidents \
  -H "content-type: application/json" \
  -d '{
    "input_type":"text",
    "source":"rider_report",
    "issue_category":"access_blocked",
    "order_code":"PP-1001",
    "raw_input":"Gate is locked and intercom is dead."
  }'
```

Expected: a JSON response with `status: "awaiting_customer"` and a `decision`
with `recommendedAction: "request_clarification"`. The customer email is
on its way via Resend.

---

Need the deep-dive on how the parts fit together? See `ARCHITECTURE.md`.
