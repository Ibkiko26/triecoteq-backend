import {
  coverBucket, draftIdPattern, maxCoverBytes, maxProjectImages, projectIdPattern,
  privateImages, publishedData, sourceImages, type ProjectDraft, type PublishedProject
} from "../../../shared/portfolio.ts";
import { apiKey, deleteDraft, findDraft, privileged, table, withDraftPublication, type Database } from "../_shared/draft-lifecycle.ts";
import { FrontendRepository, listPublishedProjects, PublishError, type TreeEntry } from "./github.ts";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store"
};

function reply(status: number, data: unknown): Response {
  return Response.json(data, { status, headers });
}

export async function authorise(
  request: Request, area: "portfolio" | "plans" = "portfolio"
): Promise<Database> {
  const jwt = request.headers.get("Authorization");
  if (!jwt?.startsWith("Bearer ")) throw new PublishError(401, "Sign in to the portfolio admin.");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const key = apiKey("PUBLISHABLE", "SUPABASE_ANON_KEY");
  if (!supabaseUrl || !key) throw new PublishError(503, "Supabase is missing its API configuration.");
  const caller = { apikey: key, Authorization: jwt };
  const permission = area === "plans" ? "can_manage_plans" : "is_portfolio_admin";
  const access = await fetch(`${supabaseUrl}/rest/v1/rpc/${permission}`, {
    method: "POST", headers: { ...caller, "Content-Type": "application/json" }, body: "{}"
  });
  if (access.status === 401) throw new PublishError(401, "Your session expired. Sign in again.");
  if (access.status === 404) throw new PublishError(503, "Apply the studio admin database migrations.");
  if (!access.ok || await access.json() !== true) {
    const section = area === "plans" ? "Ready-made plans" : "portfolio admin";
    throw new PublishError(403, `This account does not have ${section} access.`);
  }
  return { supabaseUrl, caller };
}

async function readDraft(supabaseUrl: string, caller: Record<string, string>, id: string): Promise<ProjectDraft> {
  const response = await fetch(`${supabaseUrl}/rest/v1/portfolio_drafts?id=eq.${id}&select=*`, { headers: caller });
  if (!response.ok) throw new PublishError(502, "Could not load the saved draft.");
  const [draft] = await response.json();
  if (!draft) throw new PublishError(404, "Save the project before publishing.");
  return draft;
}

export function isImage(bytes: Uint8Array, ext: string): boolean {
  if (ext === "jpg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (ext === "png") return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  return new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP";
}

async function readImage(draft: ProjectDraft, path: string, supabaseUrl: string, caller: Record<string, string>) {
  const match = /^([a-f0-9-]{36})\/([a-f0-9-]{36})\.(jpg|png|webp)$/.exec(path);
  if (!match || match[1] !== draft.id) throw new PublishError(400, "Choose a valid project image.");
  const response = await fetch(
    `${supabaseUrl}/storage/v1/object/authenticated/${coverBucket}/${path}`, { headers: caller }
  );
  if (!response.ok) throw new PublishError(400, "An uploaded project image is missing. Update the images before publishing.");
  if (Number(response.headers.get("content-length")) > maxCoverBytes) {
    throw new PublishError(400, "Project images must be 5 MB or smaller.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > maxCoverBytes || !isImage(bytes, match[3])) {
    throw new PublishError(400, "Choose JPEG, PNG or WebP project images of up to 5 MB each.");
  }
  return { path: `admin/portfolio-library/cms-${draft.project_id}-${match[2]}.${match[3]}`, bytes };
}

async function updatePublication(db: Database, draft: ProjectDraft, commit: string): Promise<void> {
  const query = new URLSearchParams({
    id: `eq.${draft.id}`,
    or: `(published_revision.is.null,published_revision.lt.${draft.revision})`
  });
  const response = await table(db, `portfolio_drafts?${query}`, "PATCH", {
    published_revision: draft.revision, published_commit: commit
  });
  if (!response.ok) {
    throw new PublishError(502, "The frontend commit succeeded, but the dashboard status could not update. Publish the same draft again to recover its status.");
  }
}

function deleteProject(github: FrontendRepository, draft: ProjectDraft, revision: number): Promise<string | null> {
  const originalId = draft.original_project_id ?? draft.project_id;
  return deleteDraft("portfolio_drafts", draft, revision, (assertCurrent) => github.removePortfolioEntry((project) =>
    project.studioDraftId === draft.id || (!project.studioDraftId && project.id === originalId &&
      (Boolean(draft.published_revision) || draft.source_image === project.image)), assertCurrent));
}

async function deleteWebsiteProject(github: FrontendRepository, id: string, studioDraftId?: string): Promise<string | null> {
  const { data } = await github.snapshot();
  const project = data.portfolioProjects.find((item) => item.id === id);
  if (project && project.studioDraftId !== studioDraftId) {
    throw new PublishError(409, "The published project changed. Refresh before deleting.");
  }
  const db = privileged();
  const active = { deletion_state: "neq.deleted" };
  const draft = studioDraftId
    ? await findDraft<ProjectDraft>(db, "portfolio_drafts", { ...active, id: `eq.${studioDraftId}` })
    : project && await findDraft<ProjectDraft>(db, "portfolio_drafts", {
      ...active, original_project_id: `eq.${id}`, source_image: `eq.${project.image}`
    });
  if (draft && (project || draft.deletion_state === "deleting")) {
    return deleteProject(github, draft, draft.revision);
  }
  if (!project) return null;
  const version = JSON.stringify(project);
  return github.removePortfolioEntry((item: PublishedProject) => {
    if (item.id !== id) return false;
    if (JSON.stringify(item) !== version) throw new PublishError(409, "The published project changed. Refresh before deleting.");
    return true;
  }, async () => {});
}

export async function handlePortfolioRequest(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return reply(405, { error: "Use the portfolio admin to publish." });

  try {
    const { supabaseUrl, caller } = await authorise(request);
    const raw = await request.text();
    if (raw.length > 2048) throw new PublishError(413, "The publish request is too large.");
    const body = JSON.parse(raw);
    const token = Deno.env.get("FRONTEND_GITHUB_TOKEN");
    if (body?.action === "list") {
      const projects = token
        ? (await new FrontendRepository(token).snapshot()).data.portfolioProjects
        : await listPublishedProjects();
      return reply(200, { projects });
    }
    if (!["delete", "delete-live", "publish"].includes(body?.action)) {
      throw new PublishError(400, "Choose a saved draft to publish.");
    }
    if (!token) throw new PublishError(503, "Set FRONTEND_GITHUB_TOKEN in the Supabase Edge Function secrets.");
    const github = new FrontendRepository(token);
    if (body.action === "delete-live") {
      if (typeof body.id !== "string" || body.id.length > 80 || !projectIdPattern.test(body.id) ||
        (body.studioDraftId !== undefined && (typeof body.studioDraftId !== "string" || !draftIdPattern.test(body.studioDraftId)))) {
        throw new PublishError(400, "Choose a published project to delete.");
      }
      return reply(200, { commit: await deleteWebsiteProject(github, body.id, body.studioDraftId) });
    }
    if (typeof body.id !== "string" || !draftIdPattern.test(body.id) || !Number.isSafeInteger(body.revision)) {
      throw new PublishError(400, "Choose a saved project.");
    }
    const db = privileged();
    if (body.action === "delete") {
      const draft = await findDraft<ProjectDraft>(db, "portfolio_drafts", { id: `eq.${body.id}` });
      return reply(200, { commit: draft ? await deleteProject(github, draft, body.revision) : null });
    }

    const draft = await readDraft(supabaseUrl, caller, body.id);
    if (draft.revision !== body.revision) throw new PublishError(409, "Another admin saved changes. Reopen the project before publishing.");
    if (!projectIdPattern.test(draft.project_id)) throw new PublishError(400, "Use a valid project ID.");
    const commit = await withDraftPublication("portfolio_drafts", draft, async () => {
      const images = sourceImages(draft);
      const uploads = privateImages(draft);
      if (!images.length && !uploads.length) throw new PublishError(400, "Upload at least one project image before publishing.");
      if (images.length + uploads.length > maxProjectImages) throw new PublishError(400, "Choose up to six project images.");
      const media: TreeEntry[] = [];
      for (const upload of uploads) {
        const { path, bytes } = await readImage(draft, upload, supabaseUrl, caller);
        media.push({ path, mode: "100644", type: "blob", sha: await github.blob(bytes) });
        images.push(path);
      }
      const published = await github.publish(draft, publishedData(draft, images), media, async () => {
        if ((await readDraft(supabaseUrl, caller, draft.id)).revision !== draft.revision) {
          throw new PublishError(409, "The draft changed during publishing. Reopen the project and try again.");
        }
      });
      await updatePublication(db, draft, published);
      return published;
    });
    return reply(200, { commit });
  } catch (error) {
    if (error instanceof PublishError) return reply(error.status, { error: error.message });
    if (error instanceof SyntaxError) return reply(400, { error: "The publish request could not be read." });
    console.error("Portfolio publishing failed", error instanceof Error ? error.message : "Unknown error");
    return reply(502, { error: "GitHub publishing is unavailable. Check the frontend token permissions and try again." });
  }
}
