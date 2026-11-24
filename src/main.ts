import "./styles.css";
import studioLogo from "./assets/tri-ecoteq-architects-logo.png";
import { mountPlanAdmin, showBuyerDownload } from "./plan-admin";
import {
  categories, coverExtensions, frontendRepository, frontendWebsite, maxCoverBytes, projectIdPattern,
  type DraftFields, type ProjectDraft, type PublishedProject
} from "../shared/portfolio";
import { client, hasPlansAccess, isAdmin, listDrafts, listWebsiteProjects, loadCover, publicCover, publishDraft, saveDraft } from "./backend";

const app = document.querySelector<HTMLElement>("#app")!;
const themeStorageKey = "teq-studio-theme";
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
type Theme = "light" | "dark";
let preferredTheme = readTheme();
const portfolioUrl = `${frontendWebsite}/portfolio.html`;
const commitUrl = `https://github.com/${frontendRepository}/commit/`;
const emptyFields: DraftFields = {
  project_id: "", title: "", category: "", location: "", year: "", description: "", price_label: ""
};

let drafts: ProjectDraft[] = [];
let websiteProjects: PublishedProject[] = [];
let email = "";
let view: "workspace" | "website" | "plans" = "workspace";
let canAccessPlans = false;
let filter = "";
let search = "";
let sessionVersion = 0;
let loginNotice = "";
let editor: { existing: ProjectDraft | null; original: PublishedProject | null; file: File | null; preview: string } | null = null;

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]!);
}

function target<T extends HTMLElement>(selector: string): T {
  return app.querySelector<T>(selector)!;
}

function setStatus(selector: string, message: string, error = false): void {
  const element = app.querySelector<HTMLElement>(selector);
  if (!element) return;
  element.textContent = message;
  element.dataset.error = String(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function readTheme(): Theme | null {
  try {
    const stored = window.localStorage.getItem(themeStorageKey);
    return stored === "light" || stored === "dark" ? stored : null;
  } catch {
    return null;
  }
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  app.querySelector("[data-theme-toggle]")?.setAttribute("aria-pressed", String(theme === "dark"));
}

function brandHeader(): string {
  const isDark = document.documentElement.dataset.theme === "dark";
  return `<div class="brand-header">
    <a class="brand" href="${frontendWebsite}" target="_blank" rel="noopener noreferrer">
      <img class="brand-logo" src="${studioLogo}" alt="" width="620" height="403" />
      <span>Tri-EcoTeq <small>ARCHITECTS</small></span>
    </a>
    <button class="theme-toggle" type="button" data-theme-toggle aria-label="Theme (dark mode)" aria-pressed="${isDark}">Theme</button>
  </div>`;
}

function showLogin(message = ""): void {
  clearEditor();
  app.innerHTML = `
    <main class="login-layout">
      <div class="login-brand">${brandHeader()}<div><p class="section-label">Studio workspace</p><h1>Portfolio<br /><em>administration</em></h1></div></div>
      <section class="login-card" aria-labelledby="login-title">
        <h2 id="login-title">Admin sign-in</h2>
        <form data-login>
          <label>Email address<input type="email" name="email" autocomplete="username" required /></label>
          <label>Password<input type="password" name="password" autocomplete="current-password" required /></label>
          <button class="button" type="submit">Sign in</button>
          <p class="feedback" role="status" data-login-feedback></p>
        </form>
      </section>
    </main>`;

  if (message) setStatus("[data-login-feedback]", message, true);
  const form = target<HTMLFormElement>("[data-login]");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button")!;
    if (button.disabled) return;
    button.disabled = true;
    setStatus("[data-login-feedback]", "Checking your account…");
    const values = new FormData(form);
    try {
      const { error } = await client!.auth.signInWithPassword({
        email: String(values.get("email")).trim(),
        password: String(values.get("password"))
      });
      if (error) setStatus("[data-login-feedback]", "Sign-in failed. Check your email and password.", true);
    } catch {
      setStatus("[data-login-feedback]", "Could not sign in. Check your connection and try again.", true);
    } finally {
      button.disabled = false;
    }
  });
}

function setupRequired(): void {
  app.innerHTML = `<main class="setup">${brandHeader()}<h1>Connect the admin</h1><p>Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY, then rebuild the site.</p></main>`;
}

function statusOf(draft: ProjectDraft): "Draft" | "Published" | "Unpublished changes" {
  if (draft.published_revision === null) return "Draft";
  return draft.published_revision === draft.revision ? "Published" : "Unpublished changes";
}

function workspaceRows(projects: ProjectDraft[]): string {
  return projects.map((draft) => `
    <tr>
      <td><strong>${escape(draft.title)}</strong><small>${escape(draft.project_id)}</small></td>
      <td>${escape(draft.category)}</td>
      <td>${escape(draft.location)}</td>
      <td><span class="status" data-status="${statusOf(draft)}">${statusOf(draft)}</span></td>
      <td><button class="link-button" type="button" data-edit="${escape(draft.id)}" aria-label="Edit ${escape(draft.title)}">Edit</button></td>
    </tr>`).join("");
}

function websiteRows(projects: PublishedProject[]): string {
  return projects.map((project) => `
    <tr>
      <td><strong>${escape(project.title)}</strong><small>${escape(project.id)}</small></td>
      <td>${escape(project.category)}</td>
      <td>${escape(project.location)}</td>
      <td><span class="status" data-status="Live">Live</span></td>
      <td><button class="link-button" type="button" data-import="${escape(project.id)}" aria-label="Edit published project ${escape(project.title)}">Edit</button></td>
    </tr>`).join("");
}

function renderProjects(): void {
  const list = target("[data-project-list]");
  const query = search.trim().toLowerCase();
  const matches = (...fields: string[]) => fields.join(" ").toLowerCase().includes(query);
  const rows = view === "workspace"
    ? workspaceRows(drafts.filter((draft) =>
      (!filter || statusOf(draft) === filter) && matches(draft.title, draft.project_id, draft.category, draft.location)
    ))
    : websiteRows(websiteProjects.filter((project) => matches(project.title, project.id, project.category, project.location)));

  list.innerHTML = rows
    ? `<table><thead><tr><th scope="col">Project</th><th scope="col">Category</th><th scope="col">Location</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table>`
    : `<div class="empty"><p>${query || filter ? "No projects match your filters." : view === "website" ? "No published projects to edit." : "Your saved projects will appear here."}</p></div>`;
}

function showWorkspace(message = ""): void {
  app.innerHTML = `
    <a class="skip-link" href="#main">Skip to content</a>
    <div class="layout">
      <aside class="sidebar">
        ${brandHeader()}
        <nav aria-label="Admin navigation">
          <button type="button" data-view="workspace" aria-pressed="${view === "workspace"}">Workspace</button>
          <button type="button" data-view="website" aria-pressed="${view === "website"}">Published portfolio</button>
          ${canAccessPlans ? `<button type="button" data-view="plans" aria-pressed="${view === "plans"}">Ready-made plans</button>` : ""}
        </nav>
        <div class="sidebar-bottom">
          <a href="${portfolioUrl}" target="_blank" rel="noopener noreferrer">View public portfolio</a>
          <button type="button" data-sign-out>Sign out</button>
        </div>
      </aside>
      <main id="main" class="main">
        <header class="topbar"><p>Studio admin</p><span>${escape(email)}</span></header>
        <div class="content">
          ${view === "plans" ? '<div data-plan-suite></div>' : `
          <div class="page-heading">
            <div><h1>${view === "workspace" ? "Portfolio projects" : "Published portfolio"}</h1>
              <p>${view === "workspace" ? "Save project drafts and publish them to the public portfolio." : "Open an existing published project to edit it in the workspace."}</p></div>
            <button class="button" type="button" data-new>New project</button>
          </div>
          ${view === "workspace" ? `<dl class="stats">
            <div><dt>Projects</dt><dd>${drafts.length}</dd></div>
            <div><dt>Drafts</dt><dd>${drafts.filter((draft) => statusOf(draft) === "Draft").length}</dd></div>
            <div><dt>Published</dt><dd>${drafts.filter((draft) => statusOf(draft) === "Published").length}</dd></div>
            <div><dt>Unpublished changes</dt><dd>${drafts.filter((draft) => statusOf(draft) === "Unpublished changes").length}</dd></div>
          </dl>` : ""}
          <section class="project-panel" aria-label="Projects">
            <div class="toolbar">
              <label class="search"><span class="sr-only">Search projects</span><input type="search" data-search placeholder="Search title, ID or location" value="${escape(search)}" /></label>
              ${view === "workspace" ? `<label><span class="sr-only">Filter by status</span><select data-filter>
                <option value="">All statuses</option>${["Draft", "Unpublished changes", "Published"].map((value) =>
                  `<option${value === filter ? " selected" : ""}>${value}</option>`).join("")}</select></label>` : ""}
              <button class="button button-secondary" data-refresh type="button">Refresh</button>
            </div>
            <div class="table-wrap" data-project-list></div>
          </section>
          <p class="feedback" role="status" data-workspace-feedback></p>`}
        </div>
      </main>
    </div>
    <dialog class="editor" aria-labelledby="editor-title" data-editor></dialog>`;

  target("[data-sign-out]").addEventListener("click", async () => {
    const { error } = await client!.auth.signOut();
    if (error) setStatus("[data-workspace-feedback], [data-plan-feedback]", "Could not sign out. Try again.", true);
  });
  app.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => button.addEventListener("click", () => {
    const next = button.dataset.view as typeof view;
    if (next === view) return;
    view = next;
    filter = "";
    search = "";
    showWorkspace();
    if (view === "website") void reload(false);
  }));
  if (view === "plans") {
    mountPlanAdmin(target("[data-plan-suite]"));
    return;
  }
  renderProjects();
  if (message) setStatus("[data-workspace-feedback]", message);
  target<HTMLInputElement>("[data-search]").addEventListener("input", (event) => {
    search = (event.currentTarget as HTMLInputElement).value;
    renderProjects();
  });
  app.querySelector<HTMLSelectElement>("[data-filter]")?.addEventListener("change", (event) => {
    filter = (event.currentTarget as HTMLSelectElement).value;
    renderProjects();
  });
  target("[data-new]").addEventListener("click", () => openEditor());
  target("[data-refresh]").addEventListener("click", () => reload(false));
  target("[data-project-list]").addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (button?.dataset.edit) {
      const draft = drafts.find(({ id }) => id === button.dataset.edit);
      if (draft) openEditor(draft);
    } else if (button?.dataset.import) {
      const original = websiteProjects.find(({ id }) => id === button.dataset.import);
      if (!original) return;
      const draft = drafts.find(({ project_id }) => project_id === original.id);
      openEditor(draft ?? null, draft ? null : original);
    }
  });
  target<HTMLDialogElement>("[data-editor]").addEventListener("close", clearEditor);
}

async function reload(silent: boolean): Promise<void> {
  const requested = view;
  const activeSession = sessionVersion;
  const button = app.querySelector<HTMLButtonElement>("[data-refresh]");
  if (button) button.disabled = true;
  if (!silent) setStatus("[data-workspace-feedback]", "Loading projects…");
  try {
    if (requested === "website") {
      const loaded = await listWebsiteProjects();
      if (activeSession === sessionVersion) websiteProjects = loaded;
    } else {
      const loaded = await listDrafts();
      if (activeSession === sessionVersion) drafts = loaded;
    }
    if (view === requested && activeSession === sessionVersion && !editor) showWorkspace();
  } catch (error) {
    if (view === requested && activeSession === sessionVersion) {
      setStatus("[data-workspace-feedback]", errorMessage(error), true);
    }
  } finally {
    if (button) button.disabled = false;
  }
}

function clearEditor(): void {
  if (editor?.preview.startsWith("blob:")) URL.revokeObjectURL(editor.preview);
  editor = null;
}

function importFields(project: PublishedProject): DraftFields {
  return {
    project_id: project.id, title: project.title, category: project.category, location: project.location,
    year: project.year, description: project.description, price_label: project.priceLabel ?? ""
  };
}

function openEditor(existing: ProjectDraft | null = null, original: PublishedProject | null = null): void {
  clearEditor();
  const state = { existing, original, file: null as File | null, preview: "" };
  editor = state;
  const fields = existing ?? (original ? importFields(original) : emptyFields);
  const lockId = Boolean(existing?.published_revision || existing?.source_image || original);
  const dialog = target<HTMLDialogElement>("[data-editor]");
  dialog.innerHTML = `
    <div class="editor-heading"><div><h2 id="editor-title">${existing || original ? "Edit project" : "New project"}</h2>
      <p>${original ? "Save a draft to start editing this published project." : "Enter the details shown in the public portfolio."}</p></div>
      <button class="link-button" type="button" data-close aria-label="Close editor">Close</button>
    </div>
    <form data-editor-form>
      <div class="editor-grid">
        <label>Project title<input name="title" value="${escape(fields.title)}" maxlength="150" required autofocus /></label>
        <label>Project ID<input name="project_id" value="${escape(fields.project_id)}" maxlength="80" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" title="Use lowercase letters, numbers and hyphens" aria-describedby="project-id-help" ${lockId ? "readonly" : ""} required /><small id="project-id-help">${lockId ? "The website uses this ID to identify the project." : "Lowercase letters, numbers and hyphens, for example garden-house."}</small></label>
        <label>Category<input name="category" value="${escape(fields.category)}" list="categories" maxlength="70" required /></label>
        <label>Location<input name="location" value="${escape(fields.location)}" maxlength="150" required /></label>
        <label>Year<input name="year" value="${escape(fields.year)}" inputmode="numeric" pattern="[12][0-9]{3}" maxlength="4" required /></label>
        <label><span>Price label <span class="optional">(optional)</span></span><input name="price_label" value="${escape(fields.price_label)}" maxlength="100" /></label>
      </div>
      <datalist id="categories">${categories.map((name) => `<option value="${escape(name)}">`).join("")}</datalist>
      <label>Project description<textarea name="description" rows="5" maxlength="3000" required>${escape(fields.description)}</textarea></label>
      <div class="cover">
        <div class="cover-preview" data-cover-preview><span>No cover selected</span></div>
        <label>Cover image<input type="file" name="cover" accept="image/jpeg,image/png,image/webp" aria-describedby="cover-help" />
          <small id="cover-help">JPEG, PNG or WebP, up to 5 MB.</small></label>
      </div>
      <div class="editor-actions">
        <button class="button button-secondary" name="intent" value="save" type="submit">Save draft</button>
        <button class="button" name="intent" value="publish" type="submit">Publish to website</button>
      </div>
      <p class="feedback" role="status" data-editor-feedback></p>
    </form>`;

  const form = dialog.querySelector<HTMLFormElement>("form")!;
  const fileInput = form.querySelector<HTMLInputElement>('input[name="cover"]')!;
  const titleInput = form.querySelector<HTMLInputElement>('input[name="title"]')!;
  const idInput = form.querySelector<HTMLInputElement>('input[name="project_id"]')!;
  let autoId = !idInput.value;
  let pending = false;

  function showPreview(url: string): void {
    if (editor !== state) return;
    if (state.preview.startsWith("blob:")) URL.revokeObjectURL(state.preview);
    state.preview = url;
    const preview = dialog.querySelector<HTMLElement>("[data-cover-preview]")!;
    preview.replaceChildren();
    if (url) {
      const image = new Image();
      image.alt = "Project cover preview";
      image.src = url;
      preview.append(image);
    } else {
      preview.textContent = "No cover selected";
    }
  }

  async function restoreCover(): Promise<void> {
    const url = state.existing ? await loadCover(state.existing) : publicCover(state.original?.image ?? "");
    if (!state.file) showPreview(url);
  }

  idInput.addEventListener("input", () => { autoId = !idInput.value; });
  titleInput.addEventListener("input", () => {
    if (!autoId || idInput.readOnly) return;
    idInput.value = titleInput.value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80).replace(/-$/, "");
  });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0] ?? null;
    const valid = !file || (Object.hasOwn(coverExtensions, file.type) && file.size > 0 && file.size <= maxCoverBytes);
    fileInput.setCustomValidity(valid ? "" : "Choose a JPEG, PNG or WebP image of up to 5 MB.");
    if (!valid) fileInput.reportValidity();
    state.file = valid ? file : null;
    if (state.file) showPreview(URL.createObjectURL(state.file));
    else void restoreCover();
  });
  dialog.querySelector("[data-close]")!.addEventListener("click", () => dialog.close());
  dialog.oncancel = (event) => { if (pending) event.preventDefault(); };
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (pending || !form.reportValidity()) return;
    const publish = (event.submitter as HTMLButtonElement | null)?.value === "publish";
    const values = Object.fromEntries(new FormData(form));
    const details = Object.fromEntries(Object.keys(emptyFields).map((key) => [key, String(values[key] ?? "").trim()])) as unknown as DraftFields;
    if (!projectIdPattern.test(details.project_id)) {
      setStatus("[data-editor-feedback]", "Enter a project ID using lowercase letters, numbers and hyphens.", true);
      return;
    }
    if (publish && !state.file && !state.existing?.cover_path && !state.existing?.source_image && !state.original?.image) {
      setStatus("[data-editor-feedback]", "Choose a cover image before publishing.", true);
      return;
    }

    pending = true;
    const controls = Array.from(dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>("input, button, textarea"));
    controls.forEach((control) => { control.disabled = true; });
    setStatus("[data-editor-feedback]", publish ? "Saving and publishing… It may take a moment." : "Saving draft…");
    try {
      const saved = await saveDraft(details, state.existing, state.original, state.file);
      if (editor !== state) return;
      state.existing = saved;
      drafts = [saved, ...drafts.filter(({ id }) => id !== saved.id)];
      state.file = null;
      fileInput.value = "";
      if (publish) {
        const commit = await publishDraft(saved);
        if (editor !== state) return;
        const updated = { ...saved, published_revision: saved.revision, published_commit: commit };
        drafts = drafts.map((draft) => draft.id === saved.id ? updated : draft);
        clearEditor();
        dialog.close();
        view = "workspace";
        showWorkspace("Published to the frontend repository. The website updates after its deployment.");
        const feedback = target("[data-workspace-feedback]");
        const link = document.createElement("a");
        link.href = commitUrl + commit;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "View GitHub commit";
        feedback.append(" ", link);
      } else {
        clearEditor();
        dialog.close();
        view = "workspace";
        showWorkspace("Draft saved.");
      }
    } catch (error) {
      setStatus("[data-editor-feedback]", errorMessage(error), true);
    } finally {
      pending = false;
      controls.forEach((control) => { control.disabled = false; });
    }
  });
  dialog.showModal();
  void restoreCover();
}

async function updateSession(): Promise<void> {
  const version = ++sessionVersion;
  const { data } = await client!.auth.getSession();
  if (version !== sessionVersion) return;
  if (!data.session) {
    drafts = [];
    websiteProjects = [];
    canAccessPlans = false;
    view = "workspace";
    filter = "";
    search = "";
    showLogin(loginNotice);
    loginNotice = "";
    return;
  }
  try {
    const [allowed, plansAllowed] = await Promise.all([isAdmin(), hasPlansAccess()]);
    if (version !== sessionVersion) return;
    if (!allowed) {
      loginNotice = "This account does not have portfolio admin access.";
      const { error } = await client!.auth.signOut({ scope: "local" });
      if (error) showLogin(loginNotice);
      return;
    }
    canAccessPlans = plansAllowed;
    if (!canAccessPlans && view === "plans") view = "workspace";
    email = data.session.user.email ?? "Portfolio administrator";
    showWorkspace();
    await reload(true);
  } catch (error) {
    if (version === sessionVersion) showLogin(errorMessage(error));
  }
}

applyTheme(preferredTheme ?? (systemTheme.matches ? "dark" : "light"));
systemTheme.addEventListener("change", ({ matches }) => {
  if (preferredTheme === null) applyTheme(matches ? "dark" : "light");
});
app.addEventListener("click", (event) => {
  if (!(event.target instanceof Element) || !event.target.closest("[data-theme-toggle]")) return;
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  preferredTheme = next;
  applyTheme(next);
  try {
    window.localStorage.setItem(themeStorageKey, next);
  } catch {
    // The selected theme still applies for the current page.
  }
});

const downloadToken = new URLSearchParams(window.location.hash.slice(1)).get("download");
if (downloadToken !== null) {
  showBuyerDownload(app, downloadToken);
} else if (!client) {
  setupRequired();
} else {
  app.innerHTML = '<main class="setup"><p role="status">Loading admin workspace…</p></main>';
  client.auth.onAuthStateChange((event) => {
    if (event === "INITIAL_SESSION" || event === "SIGNED_IN" || event === "SIGNED_OUT") {
      if (event === "SIGNED_IN" && app.querySelector("[data-project-list]")) return;
      setTimeout(() => void updateSession(), 0);
    }
  });
}
