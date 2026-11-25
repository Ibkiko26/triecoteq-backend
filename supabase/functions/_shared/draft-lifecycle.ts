import { PublishError } from "../publish-portfolio/github.ts";

export interface Database {
  supabaseUrl: string;
  caller: Record<string, string>;
}

type DraftTable = "portfolio_drafts" | "plan_drafts";
type DraftState = "active" | "deleting" | "deleted";

interface Draft {
  id: string;
  revision: number;
  deletion_state: DraftState;
}

export function apiKey(kind: "PUBLISHABLE" | "SECRET", fallback: string): string | undefined {
  const keys = Deno.env.get(`SUPABASE_${kind}_KEYS`);
  return (keys ? JSON.parse(keys)?.default : undefined) || Deno.env.get(fallback);
}

export function privileged(): Database {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const secret = apiKey("SECRET", "SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !secret) throw new PublishError(503, "Supabase is missing its server API configuration.");
  const caller: Record<string, string> = { apikey: secret, "Content-Type": "application/json" };
  if (!secret.startsWith("sb_secret_")) caller.Authorization = `Bearer ${secret}`;
  return { supabaseUrl, caller };
}

export function table(db: Database, path: string, method = "GET", body?: unknown): Promise<Response> {
  return fetch(`${db.supabaseUrl}/rest/v1/${path}`, {
    method, headers: db.caller, body: body === undefined ? undefined : JSON.stringify(body)
  });
}

export async function findDraft<T extends Draft>(db: Database, name: DraftTable, filters: Record<string, string>): Promise<T | undefined> {
  const query = new URLSearchParams({ ...filters, select: "*", limit: "1" });
  const response = await table(db, `${name}?${query}`);
  if (!response.ok) throw new PublishError(502, "Could not load the saved item.");
  const [draft]: T[] = await response.json();
  return draft;
}

async function updateDraft(name: DraftTable, filters: Record<string, string>, changes: object): Promise<boolean> {
  const db = privileged();
  db.caller.Prefer = "return=representation";
  const query = new URLSearchParams({ ...filters, select: "id" });
  const response = await table(db, `${name}?${query}`, "PATCH", changes);
  if (!response.ok) throw new PublishError(502, "Could not update the saved item. Try again.");
  return (await response.json()).length === 1;
}

function availableForPublicationChange(): string {
  return `(publish_lock_until.is.null,publish_lock_until.lt.${new Date().toISOString()})`;
}

export async function withDraftPublication<T>(name: DraftTable, draft: Draft, publish: () => Promise<T>): Promise<T> {
  const id = `eq.${draft.id}`;
  // This lease outlasts an Edge Function invocation and expires if the worker stops.
  const lock = new Date(Date.now() + 10 * 60_000).toISOString();
  if (!await updateDraft(name, {
    id, revision: `eq.${draft.revision}`, deletion_state: "eq.active", or: availableForPublicationChange()
  }, { publish_lock_until: lock })) {
    throw new PublishError(409, "This item changed or another operation is in progress. Refresh and try again.");
  }
  try {
    return await publish();
  } finally {
    await updateDraft(name, { id, publish_lock_until: `eq.${lock}` }, { publish_lock_until: null }).catch((error) => {
      console.error("Could not release the publication lock", error);
    });
  }
}

export async function deleteDraft(
  name: DraftTable, draft: Draft, revision: number, removeListing: (assertCurrent: () => Promise<void>) => Promise<string | null>
): Promise<string | null> {
  if (draft.deletion_state === "deleted") return null;
  if (draft.revision !== revision) throw new PublishError(409, "Another admin saved changes. Refresh before deleting.");
  const id = `eq.${draft.id}`;
  if (draft.deletion_state === "active" && !await updateDraft(name, {
    id, revision: `eq.${revision}`, deletion_state: "eq.active", or: availableForPublicationChange()
  }, { deletion_state: "deleting" })) {
    throw new PublishError(409, "This item changed or another operation is in progress. Refresh and try again.");
  }

  const assertCurrent = async () => {
    const current = await findDraft(privileged(), name, { id, deletion_state: "eq.deleting" });
    if (!current) throw new PublishError(409, "This item is already deleted. Refresh the list.");
  };
  const commit = await removeListing(assertCurrent);
  await updateDraft(name, { id, deletion_state: "eq.deleting" }, { deletion_state: "deleted" });
  return commit;
}
