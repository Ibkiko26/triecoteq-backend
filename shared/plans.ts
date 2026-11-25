export const plansFile = "content/buy-plans.json";
export const planBucket = "private-plan-files";
export const previewBytes = 5 * 1024 * 1024;
export const drawingBytes = 25 * 1024 * 1024;
export const maxRenders = 6;
export const planIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;
export const downloadTokenPattern = /^[a-f0-9]{64}$/;

export interface PublicPlan {
  id: string;
  title: string;
  description: string;
  currentPrice: number;
  oldPrice: number | null;
  offer: boolean;
  images: string[];
  demoPdf?: string;
  studioDraftId?: string;
}

export interface PlanFields {
  plan_id: string;
  title: string;
  description: string;
  current_price: number;
  old_price: number | null;
  offer: boolean;
}

export interface PlanDraft extends PlanFields {
  id: string;
  original_id: string | null;
  original_images: string[];
  original_demo: string | null;
  render_paths: string[];
  demo_path: string | null;
  drawing_path: string | null;
  revision: number;
  deletion_state: "active" | "deleting" | "deleted";
  published_revision: number | null;
  published_drawing_path: string | null;
  published_commit: string | null;
}

export interface PlanGrant {
  id: string;
  order_reference: string;
  buyer_email: string;
  expires_at: string;
  revoked_at: string | null;
}

export function publicRender(path: string): boolean {
  return /^\/(?:Images\/Buy-Plan|assets\/buy-plan)\/[a-z0-9_ .%-]+\.(?:jpe?g|png|webp)$/i.test(path)
    && !path.includes("..") && !/%(?:2e|2f|5c)/i.test(path);
}

export function publicDemo(path: string): boolean {
  return /^\/assets\/plan-demos\/[a-z0-9_-]+\.pdf$/i.test(path);
}

export function privatePlanPath(id: string, path: string, kind: "renders" | "demo" | "drawings"): boolean {
  const match = /^([a-f0-9-]{36})\/(renders|demo|drawings)\/([a-f0-9-]{36})\.(jpg|png|webp|pdf)$/.exec(path);
  return Boolean(match && match[1] === id && match[2] === kind && (match[4] === "pdf") === (kind !== "renders"));
}
