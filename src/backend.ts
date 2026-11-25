import { createClient, FunctionsHttpError } from "@supabase/supabase-js";
import {
  coverBucket, coverExtensions, frontendWebsite, maxProjectImages, privateImages, projectImagePath, projectImages, sourceImages,
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

export async function previewProjectImages(draft: ProjectDraft | null, original: PublishedProject | null): Promise<string[]> {
  if (!draft) return original ? projectImages(original).map(publicCover) : [];
  const urls = sourceImages(draft).map(publicCover);
  const paths = privateImages(draft);
  if (!paths.length) return urls;
  const { data } = await client!.storage.from(coverBucket).createSignedUrls(paths, 600);
  return [...urls, ...(data?.flatMap(({ signedUrl }) => signedUrl ? [signedUrl] : []) ?? [])];
}

export async function saveDraft(
  fields: DraftFields,
  existing: ProjectDraft | null,
  original: PublishedProject | null,
  files: File[],
  replaceImages: boolean
): Promise<ProjectDraft> {
  const id = existing?.id ?? crypto.randomUUID();
  const originalImages = original ? projectImages(original) : [];
  const replacing = replaceImages && files.length > 0;
  const sourceCount = replacing ? 0 : existing ? sourceImages(existing).length : originalImages.length;
  let cover = replacing ? null : existing?.cover_path ?? null;
  const gallery = replacing ? [] : [...(existing?.gallery_paths ?? [])];
  if (sourceCount + Number(Boolean(cover)) + gallery.length + files.length > maxProjectImages) {
    throw new Error("Choose up to six project images.");
  }

  const uploaded: string[] = [];
  const storage = client!.storage.from(coverBucket);
  try {
    for (const file of files) {
      const extension = coverExtensions[file.type as keyof typeof coverExtensions];
      const path = `${id}/${crypto.randomUUID()}.${extension}`;
      const { error } = await storage.upload(path, file, { contentType: file.type, upsert: false });
      if (error) throw new Error(`Could not upload ${file.name}. Try again.`);
      uploaded.push(path);
      if (!cover && !sourceCount) cover = path;
      else gallery.push(path);
    }

    const table = client!.from("portfolio_drafts");
    const values = { ...fields, cover_path: cover, gallery_paths: gallery };
    const query = existing
      ? table.update(values).eq("id", id).eq("revision", existing.revision)
      : table.insert({ ...values, id, source_image: originalImages[0] ?? null, source_images: originalImages, original_project_id: original?.id ?? null });
    const { data, error } = await query.select("*").maybeSingle();
    if (data && !error) return data as ProjectDraft;
    if (error?.code === "23505") throw new Error("That project ID is already in the workspace.");
    if (!error) throw new Error("Another admin saved changes. Reopen the project and try again.");
    throw new Error("Could not save the draft. Check the details and try again.");
  } catch (error) {
    if (uploaded.length) await storage.remove(uploaded);
    throw error;
  }
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
