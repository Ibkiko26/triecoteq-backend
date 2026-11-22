import { coverExtensions, frontendWebsite } from "../shared/portfolio";
import {
  downloadTokenPattern, drawingBytes, maxRenders, planIdPattern, previewBytes,
  type PlanDraft, type PlanFields, type PlanGrant, type PublicPlan
} from "../shared/plans";
import {
  issuePlanLink, livePlans, loadPlans, previewRenders, publishPlan, readGrants,
  redeemPlanLink, revokePlanLink, savePlan, type PlanFiles
} from "./plan-api";
import { client } from "./backend";

const formatter = new Intl.NumberFormat("en-KE", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const dateFormat = new Intl.DateTimeFormat("en-KE", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Nairobi" });

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (key) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[key]!);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

function note(root: ParentNode, selector: string, text: string, error = false): void {
  const node = root.querySelector<HTMLElement>(selector);
  if (!node) return;
  node.textContent = text;
  node.dataset.error = String(error);
}

function state(plan: PlanDraft): string {
  if (!plan.published_revision) return "Draft";
  return plan.revision === plan.published_revision ? "Published" : "Unpublished changes";
}

function dates(end: string): string {
  return dateFormat.format(new Date(end));
}

export function mountPlanAdmin(root: HTMLElement): void {
  let plans: PlanDraft[] = [];
  let published: PublicPlan[] = [];
  let website = false;
  let search = "";
  let request = 0;

  root.innerHTML = `
    <div class="page-heading"><div><h1>Ready-made plans</h1><p>Publish previews to the catalogue and issue drawing access after payment.</p></div>
      <button class="button" data-new-plan type="button">New plan</button></div>
    <section class="project-panel" aria-label="Ready-made plans">
      <div class="toolbar">
        <label class="search"><span class="sr-only">Search plans</span><input type="search" data-plan-search placeholder="Search title or plan ID" /></label>
        <button class="button button-secondary" type="button" data-plan-website aria-pressed="false">Website catalogue</button>
        <button class="button button-secondary" type="button" data-plan-refresh>Refresh</button>
      </div>
      <div class="table-wrap" data-plan-list></div>
    </section>
    <p class="feedback" role="status" data-plan-feedback></p>
    <dialog class="editor" data-plan-editor aria-labelledby="plan-editor-title"></dialog>
    <dialog class="editor" data-plan-access aria-labelledby="plan-access-title"></dialog>`;

  const list = root.querySelector<HTMLElement>("[data-plan-list]")!;
  const editor = root.querySelector<HTMLDialogElement>("[data-plan-editor]")!;
  const access = root.querySelector<HTMLDialogElement>("[data-plan-access]")!;
  const toggle = root.querySelector<HTMLButtonElement>("[data-plan-website]")!;
  const refresh = root.querySelector<HTMLButtonElement>("[data-plan-refresh]")!;

  function render(): void {
    if (!root.isConnected) return;
    const query = search.toLowerCase().trim();
    const matching = (title: string, id: string) => (title + " " + id).toLowerCase().includes(query);
    const items = website ? published.filter(({ title, id }) => matching(title, id)).map((plan) => ({
      title: plan.title, planId: plan.id, price: plan.currentPrice, status: "On website",
      edit: `data-import-plan="${escape(plan.id)}"`, access: ""
    })) : plans.filter(({ title, plan_id }) => matching(title, plan_id)).map((plan) => ({
      title: plan.title, planId: plan.plan_id, price: plan.current_price, status: state(plan),
      edit: `data-edit-plan="${escape(plan.id)}"`,
      access: plan.published_drawing_path ? `<button class="link-button" type="button" data-access-plan="${escape(plan.id)}" aria-label="Manage access for ${escape(plan.title)}">Download access</button>` : ""
    }));

    list.innerHTML = items.length ? `<table class="admin-plan-table"><thead><tr>
      <th scope="col">Plan</th><th scope="col">Price</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${items.map((item) => `<tr><td><strong>${escape(item.title)}</strong><small>${escape(item.planId)}</small></td>
      <td>${formatter.format(item.price)}</td><td><span class="status" data-status="${item.status}">${item.status}</span></td>
      <td><div class="plan-row-actions"><button class="link-button" type="button" ${item.edit} aria-label="Edit ${escape(item.title)}">Edit</button>${item.access}</div></td></tr>`).join("")}</tbody></table>`
      : `<div class="empty"><p>${query ? "No plans match your search." : "Plans will appear here."}</p></div>`;
  }

  async function reload(notice = ""): Promise<void> {
    const id = ++request;
    const showWebsite = website;
    refresh.disabled = true;
    note(root, "[data-plan-feedback]", notice || "Loading plans…");
    try {
      if (showWebsite) {
        const result = await livePlans();
        if (request !== id) return;
        published = result.plans;
      } else {
        const result = await loadPlans();
        if (request !== id) return;
        plans = result;
      }
      render();
      note(root, "[data-plan-feedback]", notice);
    } catch (error) {
      if (request === id) note(root, "[data-plan-feedback]", message(error), true);
    } finally {
      if (request === id) refresh.disabled = false;
    }
  }

  function openEditor(current: PlanDraft | null = null, original: PublicPlan | null = null): void {
    let saved = current;
    let pending = false;
    let objectUrls: string[] = [];
    const id = current?.plan_id ?? original?.id ?? "";
    const title = current?.title ?? original?.title ?? "";
    const description = current?.description ?? original?.description ?? "";
    const offer = current?.offer ?? original?.offer ?? false;
    const price = current?.current_price ?? original?.currentPrice ?? "";
    const oldPrice = current?.old_price ?? original?.oldPrice ?? "";
    const locked = Boolean(current?.published_revision || current?.original_id || original);

    editor.innerHTML = `
      <div class="editor-heading"><div><h2 id="plan-editor-title">${current || original ? "Edit plan" : "New plan"}</h2>
        <p>Choose which files clients can see before they purchase.</p></div>
        <button class="link-button" type="button" data-close-plan>Close</button></div>
      <form data-plan-form>
        <div class="editor-grid">
          <label>Title<input name="title" maxlength="150" required autofocus value="${escape(title)}" /></label>
          <label>Plan ID<input name="plan_id" maxlength="80" pattern="[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*" required value="${escape(id)}" ${locked ? "readonly" : ""} /><small>Letters, numbers and hyphens.</small></label>
          <label>Price (USD)<input name="current_price" type="number" min="1" max="1000000" step="1" required value="${escape(String(price))}" /></label>
          <label>Previous price (USD)<input name="old_price" type="number" min="1" max="1000000" step="1" value="${escape(String(oldPrice))}" /></label>
        </div>
        <label class="plan-check"><input type="checkbox" name="offer" ${offer ? "checked" : ""} /> Promotional plan unlocked with three paid plans</label>
        <label>Description<textarea name="description" rows="4" required maxlength="3000">${escape(description)}</textarea></label>
        <fieldset class="plan-files"><legend>Public previews</legend>
          <label>Renders<input type="file" name="renders" multiple accept="image/jpeg,image/png,image/webp" />
            <small>Up to six JPEG, PNG or WebP files of 5 MB each. A new selection replaces the current renders.</small></label>
          <div class="plan-render-strip" data-render-strip></div>
          <label><span>Sample PDF <span class="optional">(optional)</span></span><input type="file" name="demo" accept=".pdf,application/pdf" />
            <small>Up to 5 MB. Anyone browsing the catalogue can open this file.</small></label>
          <p class="file-state" data-demo-state></p>
        </fieldset>
        <fieldset class="plan-files"><legend>Buyer-only download</legend>
          <label>Full drawing PDF<input type="file" name="drawing" accept=".pdf,application/pdf" />
            <small>Up to 25 MB. This file is required to publish and is available through a purchaser’s private link.</small></label>
          <p class="file-state" data-drawing-state></p>
        </fieldset>
        <div class="editor-actions">
          <button class="button button-secondary" name="intent" value="save" type="submit">Save draft</button>
          <button class="button" name="intent" value="publish" type="submit">Publish plan</button>
        </div>
        <p class="feedback" role="status" data-plan-editor-feedback></p>
      </form>`;

    const form = editor.querySelector<HTMLFormElement>("[data-plan-form]")!;
    const input = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
    const file = (name: string) => input(name).files?.[0] ?? null;
    function fileState(): void {
      note(editor, "[data-demo-state]", saved?.demo_path || saved?.original_demo || original?.demoPdf ? "A sample PDF is saved." : "");
      note(editor, "[data-drawing-state]", saved?.drawing_path ? "A private drawing PDF is saved." : "No drawing PDF is saved.");
    }

    function updateOffer(): void {
      const promotional = input("offer").checked;
      input("current_price").disabled = promotional;
      input("old_price").disabled = promotional;
    }

    function showRenders(urls: string[]): void {
      const strip = editor.querySelector("[data-render-strip]")!;
      strip.replaceChildren(...urls.map((url, index) => {
        const image = new Image();
        image.src = url;
        image.alt = `Render ${index + 1}`;
        return image;
      }));
    }

    function revokePreviews(): void {
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
      objectUrls = [];
    }

    let manuallySetId = Boolean(id);
    input("plan_id").addEventListener("input", () => { manuallySetId = Boolean(input("plan_id").value); });
    input("title").addEventListener("input", () => {
      if (locked || manuallySetId) return;
      input("plan_id").value = input("title").value.toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 80).replace(/-$/, "");
    });
    input("offer").addEventListener("change", updateOffer);
    input("renders").addEventListener("change", () => {
      revokePreviews();
      const selection = Array.from(input("renders").files ?? []);
      if (selection.length <= maxRenders && selection.every((item) => Object.hasOwn(coverExtensions, item.type))) {
        objectUrls = selection.map((item) => URL.createObjectURL(item));
        showRenders(objectUrls);
      }
    });
    editor.querySelector("[data-close-plan]")!.addEventListener("click", () => editor.close());
    editor.oncancel = (event) => { if (pending) event.preventDefault(); };
    editor.onclose = revokePreviews;
    updateOffer();
    fileState();

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (pending || !form.reportValidity()) return;
      const publish = (event.submitter as HTMLButtonElement | null)?.value === "publish";
      const values = new FormData(form);
      const promotional = input("offer").checked;
      const previous = String(values.get("old_price") ?? "").trim();
      const fields: PlanFields = {
        plan_id: String(values.get("plan_id") ?? "").trim(), title: String(values.get("title") ?? "").trim(),
        description: String(values.get("description") ?? "").trim(), offer: promotional,
        current_price: promotional ? 0 : Number(values.get("current_price")),
        old_price: promotional || !previous ? null : Number(previous)
      };
      const files: PlanFiles = { renders: Array.from(input("renders").files ?? []), demo: file("demo"), drawing: file("drawing") };
      let error = "";
      if (!planIdPattern.test(fields.plan_id)) error = "Enter an ID with letters, numbers and hyphens.";
      else if (fields.old_price !== null && fields.old_price <= fields.current_price) error = "The previous price must exceed the current price.";
      else if (files.renders.length > maxRenders || files.renders.some((item) =>
        !Object.hasOwn(coverExtensions, item.type) || !item.size || item.size > previewBytes)) {
        error = "Choose up to six JPEG, PNG or WebP renders of 5 MB each.";
      } else if ([["sample", files.demo, previewBytes], ["drawing", files.drawing, drawingBytes]].some(([, item, limit]) =>
        item instanceof File && (!/\.pdf$/i.test(item.name) || !item.size || item.size > Number(limit)))) {
        error = "Choose a sample PDF up to 5 MB or a drawing PDF up to 25 MB.";
      } else if (files.demo && files.drawing && files.demo.name === files.drawing.name && files.demo.size === files.drawing.size) {
        error = "Choose a separate sample file for the public preview.";
      }
      if (error) {
        note(editor, "[data-plan-editor-feedback]", error, true);
        return;
      }

      pending = true;
      const controls = Array.from(editor.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>("input, button, textarea"));
      controls.forEach((control) => { control.disabled = true; });
      note(editor, "[data-plan-editor-feedback]", publish ? "Saving and publishing plan…" : "Saving draft…");
      try {
        saved = await savePlan(fields, saved, original, files);
        for (const field of ["renders", "demo", "drawing"]) input(field).value = "";
        fileState();
        if (publish) await publishPlan(saved);
        editor.close();
        website = false;
        toggle.setAttribute("aria-pressed", "false");
        await reload(publish ? "Plan published to the frontend repository." : "Plan draft saved.");
      } catch (error) {
        note(editor, "[data-plan-editor-feedback]", message(error), true);
      } finally {
        pending = false;
        controls.forEach((control) => { control.disabled = false; });
        updateOffer();
      }
    });

    editor.showModal();
    void previewRenders(saved, original).then((urls) => {
      if (editor.open && input("renders").files?.length === 0 && editor.contains(input("renders"))) showRenders(urls);
    }).catch(() => null);
  }

  function openAccess(plan: PlanDraft): void {
    access.innerHTML = `
      <div class="editor-heading"><div><h2 id="plan-access-title">Buyer downloads</h2><p>${escape(plan.title)} · ${escape(plan.plan_id)}</p></div>
        <button class="link-button" type="button" data-close-access>Close</button></div>
      <form data-grant-form>
        <div class="editor-grid">
          <label>Buyer email<input name="buyer" type="email" maxlength="254" required /></label>
          <label>Payment reference<input name="reference" maxlength="100" required /></label>
        </div>
        <label class="plan-check"><input name="paid" type="checkbox" required /> I have verified payment for this plan.</label>
        <div class="editor-actions"><button class="button" type="submit">Generate private link</button></div>
      </form>
      <div class="issued-link" data-issued hidden>
        <label>Buyer download link<input data-issued-url readonly /></label>
        <button class="button button-secondary" type="button" data-copy-link>Copy link</button>
        <p class="feedback" data-issued-expiry></p>
      </div>
      <p class="feedback" role="status" data-access-feedback></p>
      <section class="grant-history"><h3>Issued links</h3><div data-grant-history></div></section>`;

    const form = access.querySelector<HTMLFormElement>("[data-grant-form]")!;
    const controls = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const close = access.querySelector<HTMLButtonElement>("[data-close-access]")!;
    const history = access.querySelector<HTMLElement>("[data-grant-history]")!;

    function grantRow(grant: PlanGrant): string {
      const status = grant.revoked_at ? "Revoked" : Date.parse(grant.expires_at) <= Date.now() ? "Expired" : "Active";
      return `<article class="grant-entry"><div><strong>${escape(grant.order_reference)}</strong><p>${escape(grant.buyer_email)}</p>
        <small>${status} · expires ${dates(grant.expires_at)} EAT</small></div>
        ${status === "Active" ? `<button class="link-button" type="button" data-revoke="${escape(grant.id)}">Revoke</button>` : ""}</article>`;
    }
    async function loadHistory(): Promise<void> {
      try {
        const grants = await readGrants(plan.id);
        history.innerHTML = grants.map(grantRow).join("") || "<p>No download links issued yet.</p>";
      } catch (error) {
        note(access, "[data-access-feedback]", message(error), true);
      }
    }

    close.addEventListener("click", () => access.close());
    access.oncancel = (event) => { if (controls.disabled) event.preventDefault(); };
    access.onclose = () => { access.replaceChildren(); };
    history.addEventListener("click", async (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-revoke]");
      if (!button?.dataset.revoke) return;
      button.disabled = true;
      try {
        await revokePlanLink(button.dataset.revoke);
        note(access, "[data-access-feedback]", "Download link revoked.");
        await loadHistory();
      } catch (error) {
        note(access, "[data-access-feedback]", message(error), true);
        button.disabled = false;
      }
    });
    access.querySelector("[data-copy-link]")!.addEventListener("click", async () => {
      const input = access.querySelector<HTMLInputElement>("[data-issued-url]")!;
      try {
        await navigator.clipboard.writeText(input.value);
        note(access, "[data-access-feedback]", "Link copied. Share it with the verified buyer.");
      } catch {
        input.select();
        note(access, "[data-access-feedback]", "Select and copy the download link.");
      }
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (controls.disabled || !form.reportValidity()) return;
      const data = new FormData(form);
      if (!data.has("paid")) return;
      controls.disabled = true;
      close.disabled = true;
      note(access, "[data-access-feedback]", "Creating a download link…");
      try {
        const { token, expiresAt } = await issuePlanLink(plan.id, String(data.get("buyer")), String(data.get("reference")));
        const url = new URL(window.location.pathname, window.location.origin);
        url.hash = "download=" + token;
        access.querySelector<HTMLInputElement>("[data-issued-url]")!.value = url.href;
        access.querySelector<HTMLElement>("[data-issued]")!.hidden = false;
        note(access, "[data-issued-expiry]", `Expires ${dates(expiresAt)} EAT.`);
        note(access, "[data-access-feedback]", "Link ready. Share it with the verified buyer.");
        form.reset();
        await loadHistory();
      } catch (error) {
        note(access, "[data-access-feedback]", message(error), true);
      } finally {
        controls.disabled = false;
        close.disabled = false;
      }
    });
    access.showModal();
    void loadHistory();
  }

  root.querySelector("[data-new-plan]")!.addEventListener("click", () => openEditor());
  refresh.addEventListener("click", () => void reload());
  toggle.addEventListener("click", () => {
    website = !website;
    toggle.setAttribute("aria-pressed", String(website));
    render();
    void reload();
  });
  root.querySelector("[data-plan-search]")!.addEventListener("input", (event) => {
    search = (event.target as HTMLInputElement).value;
    render();
  });
  list.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!button) return;
    const existing = plans.find((plan) => plan.id === (button.dataset.editPlan ?? button.dataset.accessPlan));
    if (button.dataset.accessPlan && existing) openAccess(existing);
    else if (existing) openEditor(existing);
    else if (button.dataset.importPlan) {
      const original = published.find(({ id }) => id === button.dataset.importPlan);
      if (!original) return;
      const prior = plans.find(({ plan_id }) => plan_id === original.id);
      if (prior) openEditor(prior);
      else openEditor(null, original);
    }
  });
  render();
  void reload();
}

export function showBuyerDownload(app: HTMLElement, token: string): void {
  document.title = "Drawing download | Tri-EcoTeq Architects";
  app.innerHTML = `<main class="setup plan-download">
    <a href="${frontendWebsite}">Tri-EcoTeq Architects</a>
    <h1>Download your drawings</h1>
    <p>Use the private link issued by the studio for your order.</p>
    <button class="button" type="button" data-redeem>Prepare PDF</button>
    <a class="button button-secondary" data-download hidden>Download PDF</a>
    <p class="feedback" role="status" data-download-feedback></p>
  </main>`;
  const button = app.querySelector<HTMLButtonElement>("[data-redeem]")!;
  const link = app.querySelector<HTMLAnchorElement>("[data-download]")!;
  if (!client || !downloadTokenPattern.test(token)) {
    button.hidden = true;
    note(app, "[data-download-feedback]", "This download link is unavailable. Contact the studio for help.", true);
    return;
  }

  button.addEventListener("click", async () => {
    button.disabled = true;
    link.hidden = true;
    note(app, "[data-download-feedback]", "Checking your download link…");
    try {
      const { url, plan } = await redeemPlanLink(token);
      link.href = url;
      link.hidden = false;
      note(app, "[data-download-feedback]", `Your drawing PDF for ${plan} is ready. Open it within one minute.`);
    } catch (error) {
      note(app, "[data-download-feedback]", message(error), true);
    } finally {
      button.disabled = false;
    }
  });
}
