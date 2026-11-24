import { createClient, FunctionsHttpError } from "@supabase/supabase-js";
import {
  coverBucket, coverExtensions, frontendWebsite, projectImagePath,
  type DraftFields, type ProjectDraft, type PublishedProject
} from "../shared/portfolio";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
export const client = typeof url === "string" && /^https?:\/\//.test(url) && key
  ? createClient(url, key)
  : null;

export function publicCover(path: string): string {
  if (!projectImagePath(path)) return "";
  return `${frontendWebsite}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export async function isAdmin(): Promise<boolean> {
  const { data, error } = await client!.rpc("is_portfolio_admin");
  if (error) throw new Error("Could not check admin access. Verify the portfolio database setup.");
  return data === true;
}

export async function hasPlansAccess(): Promise<boolean> {
  const { data, error } = await client!.rpc("can_manage_plans");
  return !error && data === true;
}

export async function listDrafts(): Promise<ProjectDraft[]> {
  const { data, error } = await client!.from("portfolio_drafts").select("*").order("updated_at", { ascending: false });
  if (error) throw new Error("Could not load saved projects. Check your connection and try again.");
  return data as ProjectDraft[];
}

export async function loadCover(draft: ProjectDraft): Promise<string> {
  if (!draft.cover_path) return publicCover(draft.source_image ?? "");
  const { data } = await client!.storage.from(coverBucket).createSignedUrl(draft.cover_path, 600);
  return data?.signedUrl ?? "";
}

export async function saveDraft(
  fields: DraftFields,
  existing: ProjectDraft | null,
  original: PublishedProject | null,
  file: File | null
): Promise<ProjectDraft> {
  const id = existing?.id ?? crypto.randomUUID();
  let cover = existing?.cover_path ?? null;
  if (file) {
    const extension = coverExtensions[file.type as keyof typeof coverExtensions];
    cover = `${id}/${crypto.randomUUID()}.${extension}`;
    const { error } = await client!.storage.from(coverBucket).upload(cover, file, {
      contentType: file.type, upsert: false
    });
    if (error) throw new Error("The cover image could not upload. Try again.");
  }

  const table = client!.from("portfolio_drafts");
  const values = { ...fields, cover_path: cover };
  const query = existing
    ? table.update(values).eq("id", id).eq("revision", existing.revision)
    : table.insert({ ...values, id, source_image: original?.image || null });
  const { data, error } = await query.select("*").maybeSingle();
  if (error || !data) {
    if (file && cover) await client!.storage.from(coverBucket).remove([cover]);
    if (error?.code === "23505") throw new Error("That project ID is already in the workspace.");
    if (!error) throw new Error("Another admin saved changes. Reopen the project and try again.");
    throw new Error("Could not save the draft. Check the details and try again.");
  }
  return data as ProjectDraft;
}

export async function invokeEdge<T>(name: string, body: object): Promise<T> {
  const { data, error } = await client!.functions.invoke<T>(name, { body });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const result = await error.context.json().catch(() => null);
      if (typeof result?.error === "string") throw new Error(result.error);
    }
    throw new Error("Could not reach the server. Confirm the Edge Function is deployed.");
  }
  if (!data) throw new Error("The server returned an empty response.");
  return data;
}

export async function listWebsiteProjects(): Promise<PublishedProject[]> {
  const { projects } = await invokeEdge<{ projects: PublishedProject[] }>("publish-portfolio", { action: "list" });
  return projects;
}

export async function publishDraft(draft: ProjectDraft): Promise<string> {
  const { commit } = await invokeEdge<{ commit: string }>("publish-portfolio", { action: "publish", id: draft.id, revision: draft.revision });
  return commit;
}
