import { draftIdPattern } from "../../../shared/portfolio.ts";
import {
  downloadTokenPattern, drawingBytes, maxRenders, planBucket, planIdPattern, plansFile,
  previewBytes, privatePlanPath, publicDemo, publicRender, type PlanDraft, type PublicPlan
} from "../../../shared/plans.ts";
import { apiKey, authorise, isImage } from "../publish-portfolio/handler.ts";
import { FrontendRepository, PublishError, type TreeEntry } from "../publish-portfolio/github.ts";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store"
};

interface Database {
  supabaseUrl: string;
  caller: Record<string, string>;
}

interface Purchase {
  draft_id: string;
  drawing_path: string;
  plan_id: string;
  expires_at: string;
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const invalidLink = "This download link is invalid or expired. Contact the studio for a new link.";
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function reply(status: number, data: unknown): Response {
  return Response.json(data, { status, headers });
}

function privileged(): Database {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const secret = apiKey("SECRET", "SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !secret) throw new PublishError(503, "Supabase is missing its server API configuration.");
  const caller: Record<string, string> = { apikey: secret, "Content-Type": "application/json" };
  if (!secret.startsWith("sb_secret_")) caller.Authorization = `Bearer ${secret}`;
  return { supabaseUrl, caller };
}

async function table(db: Database, path: string, method = "GET", body?: unknown): Promise<Response> {
  return await fetch(`${db.supabaseUrl}/rest/v1/${path}`, {
    method, headers: db.caller, body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function readDraft(db: Database, id: string): Promise<PlanDraft> {
  const response = await table(db, `plan_drafts?id=eq.${id}&select=*`);
  if (!response.ok) throw new PublishError(502, "Could not load the saved plan.");
  const [draft] = await response.json();
  if (!draft) throw new PublishError(404, "Save the plan before continuing.");
  return draft;
}

async function publicPlans(github: FrontendRepository, head: string): Promise<PublicPlan[]> {
  const plans = await github.readJson<PublicPlan[]>(plansFile, head);
  if (!Array.isArray(plans) || plans.some((plan) => !plan || typeof plan.id !== "string")) {
    throw new PublishError(502, "The frontend plan catalogue has an unexpected format.");
  }
  return plans;
}

function repository(): FrontendRepository {
  const token = Deno.env.get("FRONTEND_GITHUB_TOKEN");
  if (!token) throw new PublishError(503, "Set FRONTEND_GITHUB_TOKEN in Supabase Edge Function secrets.");
  return new FrontendRepository(token);
}

async function planFile(db: Database, path: string, limit: number): Promise<Response> {
  const response = await fetch(`${db.supabaseUrl}/storage/v1/object/authenticated/${planBucket}/${path}`, {
    headers: db.caller
  });
  if (!response.ok) throw new PublishError(400, "A plan file is missing. Upload the file and save again.");
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new PublishError(400, "A plan file exceeds its upload limit.");
  }
  return response;
}

function isPdf(data: Uint8Array): boolean {
  return decoder.decode(data.subarray(0, 5)) === "%PDF-";
}

async function verifyDrawings(draft: PlanDraft, db: Database): Promise<{ path: string; sampleHash: string | null }> {
  const path = draft.drawing_path;
  if (!path || !privatePlanPath(draft.id, path, "drawings")) {
    throw new PublishError(400, "Upload the full private drawing PDF before publishing.");
  }
  const response = await planFile(db, path, drawingBytes);
  if (draft.demo_path && Number(response.headers.get("content-length")) <= previewBytes) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!isPdf(bytes) || bytes.length > drawingBytes) {
      throw new PublishError(400, "Upload a valid full drawing PDF before publishing.");
    }
    const sampleHash = bytes.length <= previewBytes ? await hashBytes(bytes) : null;
    return { path, sampleHash };
  }
  const reader = response.body?.getReader();
  const prefix = new Uint8Array(5);
  let offset = 0;
  if (!reader) throw new PublishError(400, "The full drawing PDF is empty.");
  try {
    while (offset < prefix.length) {
      const { value, done } = await reader.read();
      if (done) break;
      const bytes = value.subarray(0, prefix.length - offset);
      prefix.set(bytes, offset);
      offset += bytes.length;
    }
  } finally {
    await reader.cancel();
  }
  if (!isPdf(prefix)) throw new PublishError(400, "Upload a valid full drawing PDF before publishing.");
  return { path, sampleHash: null };
}

async function publicMedia(
  draft: PlanDraft, db: Database, github: FrontendRepository, fullDrawingHash: string | null
): Promise<{ images: string[]; demoPdf?: string; entries: TreeEntry[] }> {
  const entries: TreeEntry[] = [];
  const images: string[] = [];

  if (draft.render_paths.length > maxRenders) throw new PublishError(400, "Choose up to six public renders.");
  for (const path of draft.render_paths) {
    if (!privatePlanPath(draft.id, path, "renders")) throw new PublishError(400, "Choose a valid render image.");
    const bytes = new Uint8Array(await (await planFile(db, path, previewBytes)).arrayBuffer());
    const filename = path.split("/").pop()!;
    if (bytes.length > previewBytes || !isImage(bytes, filename.split(".").pop()!)) {
      throw new PublishError(400, "Each render must be a valid JPEG, PNG or WebP up to 5 MB.");
    }
    const target = `Images/Buy-Plan/cms-${draft.plan_id}-${filename}`;
    entries.push({ path: target, mode: "100644", type: "blob", sha: await github.blob(bytes) });
    images.push("/" + target);
  }
  if (!images.length) images.push(...draft.original_images.filter(publicRender));
  if (!images.length) throw new PublishError(400, "Add at least one public render before publishing.");

  let demoPdf = draft.original_demo && publicDemo(draft.original_demo) ? draft.original_demo : undefined;
  if (draft.demo_path) {
    if (!privatePlanPath(draft.id, draft.demo_path, "demo")) throw new PublishError(400, "Choose a valid demo PDF.");
    const bytes = new Uint8Array(await (await planFile(db, draft.demo_path, previewBytes)).arrayBuffer());
    if (bytes.length > previewBytes || !isPdf(bytes)) {
      throw new PublishError(400, "The public demo must be a valid PDF of up to 5 MB.");
    }
    if (fullDrawingHash && await hashBytes(bytes) === fullDrawingHash) {
      throw new PublishError(400, "The public sample must be different from the private drawing PDF.");
    }
    const target = `assets/plan-demos/${draft.plan_id}-${draft.demo_path.split("/").pop()}`;
    entries.push({ path: target, mode: "100644", type: "blob", sha: await github.blob(bytes) });
    demoPdf = "/" + target;
  }
  return { images, demoPdf, entries };
}

function samePlan(existing: PublicPlan, plan: PublicPlan): boolean {
  return existing.id === plan.id && existing.title === plan.title && existing.description === plan.description &&
    existing.currentPrice === plan.currentPrice && existing.oldPrice === plan.oldPrice && existing.offer === plan.offer &&
    existing.demoPdf === plan.demoPdf && JSON.stringify(existing.images) === JSON.stringify(plan.images);
}

async function publish(draft: PlanDraft, db: Database): Promise<string> {
  if (!planIdPattern.test(draft.plan_id)) throw new PublishError(400, "Choose a valid plan ID.");
  const server = privileged();
  const github = repository();
  const drawing = await verifyDrawings(draft, db);
  const { images, demoPdf, entries } = await publicMedia(draft, db, github, drawing.sampleHash);
  const plan: PublicPlan = {
    id: draft.plan_id, title: draft.title.trim(), description: draft.description.trim(),
    currentPrice: draft.current_price, oldPrice: draft.old_price, offer: draft.offer, images,
    ...(demoPdf ? { demoPdf } : {})
  };

  const assertCurrent = async () => {
    if ((await readDraft(db, draft.id)).revision !== draft.revision) {
      throw new PublishError(409, "The plan changed during publishing. Reopen it and try again.");
    }
  };
  let commit: string | null = null;
  for (let attempt = 0; attempt < 3 && !commit; attempt++) {
    await assertCurrent();
    const head = await github.head();
    const plans = await publicPlans(github, head);
    const index = plans.findIndex(({ id }) => id.toLowerCase() === plan.id.toLowerCase());
    const existing = index >= 0 ? plans[index] : undefined;
    if (plan.offer && plans.some((item) => item.offer && item.id !== plan.id)) {
      throw new PublishError(409, "The catalogue already has a promotional plan. Keep one promotional plan at a time.");
    }
    if (existing && samePlan(existing, plan)) {
      commit = head;
      break;
    }
    if (existing && (existing.id !== plan.id || (!draft.published_revision && draft.original_id !== existing.id))) {
      throw new PublishError(409, "This plan ID already exists on the website. Import it to edit that listing.");
    }

    if (existing) plans[index] = plan;
    else plans.unshift(plan);
    commit = await github.commitAt(head, [...entries, {
      path: plansFile, mode: "100644", type: "blob", content: JSON.stringify(plans, null, 2) + "\n"
    }], `Publish ready-made plan ${plan.id}`, assertCurrent);
  }
  if (!commit) throw new PublishError(409, "The frontend was updated during publishing. Try again.");

  const query = new URLSearchParams({
    id: `eq.${draft.id}`, or: `(published_revision.is.null,published_revision.lt.${draft.revision})`
  });
  const result = await table(server, `plan_drafts?${query}`, "PATCH", {
    published_revision: draft.revision, published_commit: commit, published_drawing_path: drawing.path
  });
  if (!result.ok) throw new PublishError(502, "GitHub accepted the plan. Publish again to update its admin status.");
  return commit;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function hashBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function hashToken(token: string): Promise<string> {
  return hashBytes(encoder.encode(token));
}

async function issueLink(db: Database, draft: PlanDraft, email: string, reference: string) {
  const drawing = draft.published_drawing_path;
  if (!draft.published_revision || !drawing || !privatePlanPath(draft.id, drawing, "drawings")) {
    throw new PublishError(400, "Publish this plan with a private drawing PDF before issuing access.");
  }
  if (email.length > 254 || !emailPattern.test(email) || !reference || reference.length > 100) {
    throw new PublishError(400, "Enter the buyer’s email and a payment reference.");
  }
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const result = await table(db, "plan_download_grants", "POST", {
    draft_id: draft.id, plan_id: draft.plan_id, drawing_path: drawing,
    order_reference: reference, buyer_email: email, token_hash: await hashToken(token), expires_at: expiresAt
  });
  if (!result.ok) throw new PublishError(502, "Could not issue the download link.");
  return { token, expiresAt };
}

async function redeem(token: string): Promise<Response> {
  if (!downloadTokenPattern.test(token)) return reply(404, { error: invalidLink });
  const db = privileged();
  const query = new URLSearchParams({
    token_hash: `eq.${await hashToken(token)}`, revoked_at: "is.null",
    expires_at: `gt.${new Date().toISOString()}`, select: "draft_id,drawing_path,plan_id,expires_at"
  });
  const response = await table(db, `plan_download_grants?${query}`);
  if (!response.ok) throw new PublishError(502, "Could not check the download link.");
  const [grant]: Purchase[] = await response.json();
  if (!grant || !privatePlanPath(grant.draft_id, grant.drawing_path, "drawings")) {
    return reply(404, { error: invalidLink });
  }

  const expiresIn = Math.min(60, Math.floor((Date.parse(grant.expires_at) - Date.now()) / 1000));
  if (expiresIn < 1) return reply(404, { error: invalidLink });
  const signed = await fetch(
    `${db.supabaseUrl}/storage/v1/object/sign/${planBucket}/${grant.drawing_path}`,
    { method: "POST", headers: db.caller, body: JSON.stringify({ expiresIn }) }
  );
  if (!signed.ok) throw new PublishError(502, "Could not prepare the drawing PDF. Try again.");
  const { signedURL } = await signed.json();
  if (typeof signedURL !== "string" || !signedURL.startsWith("/object/sign/")) {
    throw new PublishError(502, "Could not prepare the drawing PDF. Try again.");
  }
  const url = new URL(db.supabaseUrl + "/storage/v1" + signedURL);
  url.searchParams.set("download", `${grant.plan_id}-drawings.pdf`);
  return reply(200, { url: url.href, plan: grant.plan_id });
}

export async function handlePlansRequest(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return reply(405, { error: "Send a POST request." });

  try {
    const raw = await request.text();
    if (raw.length > 4096) return reply(413, { error: "Plan request is too large." });
    const body = JSON.parse(raw);
    if (body?.action === "redeem") {
      return await redeem(typeof body.token === "string" ? body.token : "");
    }
    const db = await authorise(request);
    if (body?.action === "list") {
      const github = repository();
      return reply(200, { plans: await publicPlans(github, await github.head()) });
    }
    if (body?.action === "revoke" && typeof body.id === "string" && draftIdPattern.test(body.id)) {
      const result = await table(privileged(), `plan_download_grants?id=eq.${body.id}&revoked_at=is.null`,
        "PATCH", { revoked_at: new Date().toISOString() });
      if (!result.ok) throw new PublishError(502, "Could not revoke the download link.");
      return reply(200, { success: true });
    }

    if (typeof body?.id !== "string" || !draftIdPattern.test(body.id)) {
      return reply(400, { error: "Choose a saved plan." });
    }
    const draft = await readDraft(db, body.id);
    if (body.action === "publish") {
      if (body.revision !== draft.revision) return reply(409, { error: "The plan changed. Reopen it before publishing." });
      return reply(200, { commit: await publish(draft, db) });
    }
    if (body.action === "grant" && body.paymentConfirmed === true &&
      typeof body.buyerEmail === "string" && typeof body.orderReference === "string") {
      return reply(201, await issueLink(privileged(), draft, body.buyerEmail.trim(), body.orderReference.trim()));
    }
    return reply(400, { error: "Check the plan details or confirm payment before issuing access." });
  } catch (error) {
    if (error instanceof PublishError) return reply(error.status, { error: error.message });
    if (error instanceof SyntaxError) return reply(400, { error: "The plan request could not be read." });
    console.error("Ready-made plan operation failed", error instanceof Error ? error.name : "Unknown error");
    return reply(502, { error: "The plan service is temporarily unavailable. Try again." });
  }
}
