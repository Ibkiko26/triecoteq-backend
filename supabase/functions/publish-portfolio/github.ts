import {
  frontendBranch, frontendRepository, matchesPublished, portfolioFile,
  type ProjectDraft, type PublishedProject
} from "../../../shared/portfolio.ts";

interface Snapshot {
  portfolioProjects: PublishedProject[];
  updatedAt?: string;
  [key: string]: unknown;
}

const deletedListingsFile = "content/deleted-listings.json";
type DeletedListings = Record<"portfolio" | "plans", string[]>;

export interface TreeEntry {
  path: string;
  mode: "100644";
  type: "blob";
  sha?: string;
  content?: string;
}

export class PublishError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function readPublishedJson<T>(path: string): Promise<T> {
  const response = await fetch(`https://raw.githubusercontent.com/${frontendRepository}/${frontendBranch}/${path}`, {
    redirect: "error",
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new PublishError(502, "Could not load the published website catalogue.");
  return response.json().catch(() => {
    throw new PublishError(502, "The published website catalogue could not be read.");
  });
}

function validatePortfolio(data: Snapshot): Snapshot {
  if (!Array.isArray(data?.portfolioProjects) ||
    !data.portfolioProjects.every((project) => project && typeof project.id === "string")) {
    throw new PublishError(502, "The frontend portfolio file has an unexpected format.");
  }
  return data;
}

export async function listPublishedProjects(): Promise<PublishedProject[]> {
  return validatePortfolio(await readPublishedJson<Snapshot>(portfolioFile)).portfolioProjects;
}

class GithubError extends Error {
  constructor(public status: number, public operation: string) {
    super("GitHub API request failed");
  }
}

function encodeFile(bytes: Uint8Array): string {
  const chunkSize = 12_288;
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))));
  }
  return chunks.join("");
}

export class FrontendRepository {
  constructor(private token: string) {}

  private async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(`https://api.github.com/repos/${frontendRepository}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json"
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(12_000)
    });
    if (!response.ok) throw new GithubError(response.status, `${method} ${path.split("?")[0]}`);
    return response.json();
  }

  async head(): Promise<string> {
    const branch = await this.request<{ object: { sha: string } }>(`/git/ref/heads/${frontendBranch}`);
    return branch.object.sha;
  }

  async readJson<T>(path: string, ref: string): Promise<T> {
    const file = await this.request<{ content: string; encoding: string }>(`/contents/${path}?ref=${ref}`);
    if (file.encoding !== "base64" || typeof file.content !== "string") {
      throw new PublishError(502, "GitHub did not return the requested catalogue file.");
    }
    const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, "")), (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  async blob(bytes: Uint8Array): Promise<string> {
    const result = await this.request<{ sha: string }>("/git/blobs", "POST", {
      content: encodeFile(bytes), encoding: "base64"
    });
    return result.sha;
  }

  async commitAt(
    head: string,
    tree: TreeEntry[],
    message: string,
    assertCurrent: () => Promise<void>
  ): Promise<string | null> {
    const parent = await this.request<{ tree: { sha: string } }>(`/git/commits/${head}`);
    const nextTree = await this.request<{ sha: string }>("/git/trees", "POST", {
      base_tree: parent.tree.sha, tree
    });
    const commit = await this.request<{ sha: string }>("/git/commits", "POST", {
      message, parents: [head], tree: nextTree.sha
    });
    await assertCurrent();

    try {
      await this.request(`/git/refs/heads/${frontendBranch}`, "PATCH", { sha: commit.sha, force: false });
      return commit.sha;
    } catch (error) {
      if (!(error instanceof GithubError) || ![409, 422].includes(error.status)) throw error;
      if (await this.head() === head) throw error;
      return null;
    }
  }

  async snapshot(): Promise<{ head: string; data: Snapshot }> {
    const head = await this.head();
    const data = validatePortfolio(await this.readJson<Snapshot>(portfolioFile, head));
    return { head, data };
  }

  async removeEntry<T extends { id: string }>(
    collection: keyof DeletedListings,
    path: string,
    label: string,
    load: (head: string) => Promise<{ entries: T[]; serialize: (entries: T[]) => string }>,
    match: (entry: T) => boolean,
    assertCurrent: () => Promise<void>,
    previousIds: (entry: T) => string[] = () => []
  ): Promise<string | null> {
    let original: string | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      await assertCurrent();
      const head = await this.head();
      const { entries, serialize } = await load(head);
      const entry = entries.find(match);
      if (!entry) return null;
      const version = JSON.stringify(entry);
      if (original !== undefined && original !== version) {
        throw new PublishError(409, "The public listing changed. Refresh before trying again.");
      }
      original = version;
      const deleted = await this.readJson<DeletedListings>(deletedListingsFile, head).catch((error) => {
        if (error instanceof GithubError && error.status === 404) return { portfolio: [], plans: [] };
        throw error;
      });
      deleted[collection] = [...new Set([...deleted[collection], entry.id, ...previousIds(entry)])];
      const commit = await this.commitAt(head, [{
        path, mode: "100644", type: "blob", content: serialize(entries.filter((item) => item !== entry))
      }, {
        path: deletedListingsFile, mode: "100644", type: "blob", content: JSON.stringify(deleted, null, 2) + "\n"
      }], `Delete ${label} ${entry.id}`, assertCurrent);
      if (commit) return commit;
    }
    throw new PublishError(409, "The frontend branch changed during deletion. Try again.");
  }

  removePortfolioEntry(match: (entry: PublishedProject) => boolean, assertCurrent: () => Promise<void>): Promise<string | null> {
    return this.removeEntry("portfolio", portfolioFile, "portfolio project", async (head) => {
      const data = validatePortfolio(await this.readJson<Snapshot>(portfolioFile, head));
      return {
        entries: data.portfolioProjects,
        serialize: (portfolioProjects) => JSON.stringify({ ...data, portfolioProjects, updatedAt: new Date().toISOString() }, null, 2) + "\n"
      };
    }, match, assertCurrent, ({ previousIds }) => previousIds ?? []);
  }

  async publish(
    draft: ProjectDraft,
    project: PublishedProject,
    media: TreeEntry[],
    assertCurrent: () => Promise<void>
  ): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await assertCurrent();
      const { head, data } = await this.snapshot();
      const projects = [...data.portfolioProjects];
      const originalId = draft.original_project_id ?? (draft.source_image || draft.published_revision ? draft.project_id : null);
      let index = projects.findIndex(({ studioDraftId }) => studioDraftId === draft.id);
      if (index < 0 && originalId) {
        const original = projects.findIndex(({ id }) => id === originalId);
        if (original >= 0) {
          const item = projects[original];
          if (item.studioDraftId || (!draft.published_revision && item.image !== draft.source_image)) {
            throw new PublishError(409, "The original website entry changed. Refresh the published portfolio before trying again.");
          }
          index = original;
        }
      }
      if (index < 0 && originalId) {
        throw new PublishError(409, "The original website entry is gone. Refresh the published portfolio.");
      }
      if (projects.some(({ id }, position) => id === project.id && position !== index)) {
        throw new PublishError(409, "This project ID is already on the website. Import that project to edit it, or choose another ID.");
      }
      if (index < 0) projects.unshift(project);
      else {
        const existing = projects[index];
        const previousIds = [...new Set([...(existing.previousIds ?? []), existing.id])].filter((id) => id !== project.id);
        const next = { ...project, ...(previousIds.length ? { previousIds } : {}) };
        if (matchesPublished(existing, next)) return head;
        projects[index] = { ...existing, ...next, previousIds: previousIds.length ? previousIds : undefined };
      }

      const tree: TreeEntry[] = [{
        path: portfolioFile, mode: "100644", type: "blob",
        content: JSON.stringify({ ...data, portfolioProjects: projects, updatedAt: new Date().toISOString() }, null, 2) + "\n"
      }];

      const commit = await this.commitAt(head, [...tree, ...media], `Publish portfolio project ${project.id}`, assertCurrent);
      if (commit) return commit;
    }
    throw new PublishError(409, "The frontend branch changed during publishing. Try again.");
  }
}
