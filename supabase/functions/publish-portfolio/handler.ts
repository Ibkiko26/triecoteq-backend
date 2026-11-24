import {
  coverBucket, draftIdPattern, maxCoverBytes, projectIdPattern, projectImagePath,
  publishedData, type ProjectDraft
} from "../../../shared/portfolio.ts";
import { FrontendRepository, listPublishedProjects, PublishError } from "./github.ts";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store"
};

function reply(status: number, data: unknown): Response {
  return Response.json(data, { status, headers });
}

export function apiKey(kind: "PUBLISHABLE" | "SECRET", fallback: string): string | undefined {
  const keys = Deno.env.get(`SUPABASE_${kind}_KEYS`);
  return (keys ? JSON.parse(keys)?.default : undefined) || Deno.env.get(fallback);
}

export async function authorise(
  request: Request, area: "portfolio" | "plans" = "portfolio"
): Promise<{ supabaseUrl: string; caller: Record<string, string> }> {
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

async function coverFor(draft: ProjectDraft, supabaseUrl: string, caller: Record<string, string>) {
  if (!draft.cover_path) {
    if (draft.source_image && projectImagePath(draft.source_image)) {
      return { image: draft.source_image, bytes: null };
    }
    throw new PublishError(400, "Upload a cover image before publishing.");
  }

  const match = /^([a-f0-9-]{36})\/([a-f0-9-]{36})\.(jpg|png|webp)$/.exec(draft.cover_path);
  if (!match || match[1] !== draft.id) throw new PublishError(400, "Choose a valid cover image.");
  const response = await fetch(
    `${supabaseUrl}/storage/v1/object/authenticated/${coverBucket}/${draft.cover_path}`, { headers: caller }
  );
  if (!response.ok) throw new PublishError(400, "The uploaded cover is missing. Save a new cover before publishing.");
  if (Number(response.headers.get("content-length")) > maxCoverBytes) {
    throw new PublishError(400, "Cover images must be 5 MB or smaller.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > maxCoverBytes || !isImage(bytes, match[3])) {
    throw new PublishError(400, "Choose a valid JPEG, PNG or WebP cover image of up to 5 MB.");
  }
  return { image: `admin/portfolio-library/cms-${draft.project_id}-${match[2]}.${match[3]}`, bytes };
}

async function updatePublication(supabaseUrl: string, secret: string, draft: ProjectDraft, commit: string): Promise<void> {
  const privileged: Record<string, string> = { apikey: secret, "Content-Type": "application/json" };
  if (!secret.startsWith("sb_secret_")) privileged.Authorization = `Bearer ${secret}`;
  const query = new URLSearchParams({
    id: `eq.${draft.id}`,
    or: `(published_revision.is.null,published_revision.lt.${draft.revision})`
  });
  const response = await fetch(`${supabaseUrl}/rest/v1/portfolio_drafts?${query}`, {
    method: "PATCH", headers: privileged,
    body: JSON.stringify({ published_revision: draft.revision, published_commit: commit })
  });
  if (!response.ok) {
    throw new PublishError(502, "The frontend commit succeeded, but the dashboard status could not update. Publish the same draft again to recover its status.");
  }
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
    if (body?.action !== "publish" || typeof body.id !== "string" || !draftIdPattern.test(body.id) || !Number.isSafeInteger(body.revision)) {
      throw new PublishError(400, "Choose a saved draft to publish.");
    }

    if (!token) throw new PublishError(503, "Set FRONTEND_GITHUB_TOKEN in the Supabase Edge Function secrets.");
    const github = new FrontendRepository(token);

    const draft = await readDraft(supabaseUrl, caller, body.id);
    if (draft.revision !== body.revision) throw new PublishError(409, "Another admin saved changes. Reopen the project before publishing.");
    if (!projectIdPattern.test(draft.project_id)) throw new PublishError(400, "Use a valid project ID.");
    const secret = apiKey("SECRET", "SUPABASE_SERVICE_ROLE_KEY");
    if (!secret) throw new PublishError(503, "Supabase is missing its server API key.");

    const cover = await coverFor(draft, supabaseUrl, caller);
    const commit = await github.publish(draft, publishedData(draft, cover.image), cover.bytes, async () => {
      if ((await readDraft(supabaseUrl, caller, draft.id)).revision !== draft.revision) {
        throw new PublishError(409, "The draft changed during publishing. Reopen the project and try again.");
      }
    });
    await updatePublication(supabaseUrl, secret, draft, commit);
    return reply(200, { commit });
  } catch (error) {
    if (error instanceof PublishError) return reply(error.status, { error: error.message });
    if (error instanceof SyntaxError) return reply(400, { error: "The publish request could not be read." });
    console.error("Portfolio publishing failed", error instanceof Error ? error.message : "Unknown error");
    return reply(502, { error: "GitHub publishing is unavailable. Check the frontend token permissions and try again." });
  }
}
