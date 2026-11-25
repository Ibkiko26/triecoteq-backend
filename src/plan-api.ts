import { client, invokeEdge } from "./backend";
import { coverExtensions, frontendWebsite } from "../shared/portfolio";
import { maxRenders, planBucket, publicRender, type PlanDraft, type PlanFields, type PlanGrant, type PublicPlan } from "../shared/plans";

export interface PlanFiles {
  renders: File[];
  replaceRenders: boolean;
  demo: File | null;
  drawing: File | null;
}

export async function loadPlans(): Promise<PlanDraft[]> {
  const { data, error } = await client!.from("plan_drafts").select("*").order("updated_at", { ascending: false });
  if (error) throw new Error("Could not load plan drafts. Check the plan database migration and try again.");
  return data as PlanDraft[];
}

export async function loadPlanDraft(planId: string): Promise<PlanDraft | null> {
  const { data, error } = await client!.from("plan_drafts").select("*").eq("plan_id", planId).maybeSingle();
  if (error) throw new Error("Could not open the plan draft. Try again.");
  return data as PlanDraft | null;
}

async function upload(id: string, kind: "renders" | "demo" | "drawings", file: File): Promise<string> {
  const extension = kind === "renders" ? coverExtensions[file.type as keyof typeof coverExtensions] : "pdf";
  const path = `${id}/${kind}/${crypto.randomUUID()}.${extension}`;
  const { error } = await client!.storage.from(planBucket).upload(path, file, {
    contentType: kind === "renders" ? file.type : "application/pdf", upsert: false
  });
  if (error) throw new Error(`Could not upload ${file.name}. Check the file size and try again.`);
  return path;
}

export async function savePlan(
  fields: PlanFields, current: PlanDraft | null, original: PublicPlan | null, files: PlanFiles
): Promise<PlanDraft> {
  const id = current?.id ?? crypto.randomUUID();
  const replacing = files.replaceRenders && files.renders.length > 0;
  const originalImages = replacing ? [] : (current?.original_images ?? original?.images ?? []).filter(publicRender);
  const existingRenders = replacing ? [] : current?.render_paths ?? [];
  if (files.renders.length && originalImages.length + existingRenders.length + files.renders.length > maxRenders) {
    throw new Error("Choose up to six render images.");
  }
  const uploaded: string[] = [];
  try {
    for (const file of files.renders) uploaded.push(await upload(id, "renders", file));
    const values = {
      ...fields, original_images: originalImages, render_paths: [...existingRenders, ...uploaded],
      demo_path: files.demo ? await upload(id, "demo", files.demo) : current?.demo_path ?? null,
      drawing_path: files.drawing ? await upload(id, "drawings", files.drawing) : current?.drawing_path ?? null
    };
    const table = client!.from("plan_drafts");
    const query = current
      ? table.update(values).eq("id", id).eq("revision", current.revision)
      : table.insert({ ...values, id, original_id: original?.id ?? null, original_demo: original?.demoPdf ?? null });
    const { data, error } = await query.select("*").maybeSingle();
    if (error?.code === "23505") throw new Error("That plan ID is already in the admin workspace.");
    if (error) throw new Error("Could not save this plan. Check the fields and file sizes.");
    if (!data) throw new Error("Another admin updated the plan. Reopen it and try again.");
    return data as PlanDraft;
  } catch (error) {
    if (uploaded.length) await client!.storage.from(planBucket).remove(uploaded);
    throw error;
  }
}

export function livePlans() {
  return invokeEdge<{ plans: PublicPlan[] }>("manage-plans", { action: "list" });
}

export function publishPlan(plan: PlanDraft) {
  return invokeEdge<{ commit: string }>("manage-plans", { action: "publish", id: plan.id, revision: plan.revision });
}

export async function previewRenders(plan: PlanDraft | null, original: PublicPlan | null): Promise<string[]> {
  const urls = (plan?.original_images ?? original?.images ?? []).filter(publicRender).map((path) => new URL(path, frontendWebsite).href);
  if (plan?.render_paths.length) {
    const { data } = await client!.storage.from(planBucket).createSignedUrls(plan.render_paths, 600);
    urls.push(...(data?.flatMap((item) => item.signedUrl ? [item.signedUrl] : []) ?? []));
  }
  return urls;
}

export async function readGrants(planId: string): Promise<PlanGrant[]> {
  const { data, error } = await client!.from("plan_download_grants")
    .select("id, order_reference, buyer_email, expires_at, revoked_at")
    .eq("draft_id", planId).order("created_at", { ascending: false });
  if (error) throw new Error("Could not load download access for this plan.");
  return data as PlanGrant[];
}

export function issuePlanLink(id: string, buyerEmail: string, orderReference: string) {
  return invokeEdge<{ token: string; expiresAt: string }>("manage-plans", {
    action: "grant", id, buyerEmail, orderReference, paymentConfirmed: true
  });
}

export function revokePlanLink(id: string) {
  return invokeEdge<{ success: boolean }>("manage-plans", { action: "revoke", id });
}

export function redeemPlanLink(token: string) {
  return invokeEdge<{ plan: string; url: string }>("manage-plans", { action: "redeem", token });
}
