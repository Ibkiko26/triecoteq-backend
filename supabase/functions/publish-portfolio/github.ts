import {
  frontendBranch, frontendRepository, matchesPublished, portfolioFile,
  type ProjectDraft, type PublishedProject
} from "../../../shared/portfolio.ts";

interface Snapshot {
  portfolioProjects: PublishedProject[];
  updatedAt?: string;
  [key: string]: unknown;
}

interface TreeEntry {
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

class GithubError extends Error {
  constructor(public status: number, public operation: string) {
    super("GitHub API request failed");
  }
}

function encodeCover(bytes: Uint8Array): string {
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

  async snapshot(): Promise<{ head: string; data: Snapshot }> {
    const branch = await this.request<{ object: { sha: string } }>(`/git/ref/heads/${frontendBranch}`);
    const head = branch.object.sha;
    const file = await this.request<{ content: string; encoding: string }>(
      `/contents/${portfolioFile}?ref=${head}`
    );
    if (file.encoding !== "base64" || typeof file.content !== "string") {
      throw new PublishError(502, "GitHub did not return the frontend portfolio file.");
    }
    const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, "")), (character) => character.charCodeAt(0));
    const data: Snapshot = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(data?.portfolioProjects) ||
      !data.portfolioProjects.every((project) => project && typeof project.id === "string")) {
      throw new PublishError(502, "The frontend portfolio file has an unexpected format.");
    }
    return { head, data };
  }

  async publish(
    draft: ProjectDraft,
    project: PublishedProject,
    cover: Uint8Array | null,
    assertCurrent: () => Promise<void>
  ): Promise<string> {
    let coverSha: string | undefined;

    for (let attempt = 0; attempt < 3; attempt++) {
      await assertCurrent();
      const { head, data } = await this.snapshot();
      const index = data.portfolioProjects.findIndex(({ id }) => id === project.id);
      const existing = index < 0 ? null : data.portfolioProjects[index];

      if (existing && matchesPublished(existing, project)) return head;
      if (existing && !draft.published_revision && existing.image !== draft.source_image) {
        throw new PublishError(409, "This project ID is already on the website. Import that project to edit it, or choose another ID.");
      }

      const projects = [...data.portfolioProjects];
      if (index < 0) projects.unshift(project);
      else projects[index] = { ...projects[index], ...project };

      const tree: TreeEntry[] = [{
        path: portfolioFile, mode: "100644", type: "blob",
        content: JSON.stringify({ ...data, portfolioProjects: projects, updatedAt: new Date().toISOString() }, null, 2) + "\n"
      }];

      if (cover) {
        if (!coverSha) {
          const base64 = encodeCover(cover);
          coverSha = (await this.request<{ sha: string }>("/git/blobs", "POST", {
            content: base64, encoding: "base64"
          })).sha;
        }
        tree.push({ path: project.image, mode: "100644", type: "blob", sha: coverSha });
      }

      const parent = await this.request<{ tree: { sha: string } }>(`/git/commits/${head}`);
      const nextTree = await this.request<{ sha: string }>("/git/trees", "POST", {
        base_tree: parent.tree.sha, tree
      });
      const commit = await this.request<{ sha: string }>("/git/commits", "POST", {
        message: `Publish portfolio project ${project.id}`,
        parents: [head],
        tree: nextTree.sha
      });

      await assertCurrent();
      try {
        await this.request(`/git/refs/heads/${frontendBranch}`, "PATCH", { sha: commit.sha, force: false });
        return commit.sha;
      } catch (error) {
        if (!(error instanceof GithubError) || ![409, 422].includes(error.status)) throw error;
        // Retry only when a different commit advanced the branch.
        if ((await this.snapshot()).head === head) throw error;
      }
    }
    throw new PublishError(409, "The frontend branch changed during publishing. Try again.");
  }
}
