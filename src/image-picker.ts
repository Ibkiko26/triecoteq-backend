import { coverExtensions, maxCoverBytes } from "../shared/portfolio";

export function imagePickerMarkup(label: string, limit: number): string {
  return `
    <label>${label}<input type="file" name="images" multiple accept="image/jpeg,image/png,image/webp" aria-describedby="upload-images-help" />
      <small id="upload-images-help">Add up to ${limit} JPEG, PNG or WebP images, 5 MB each. The first image is the cover.</small></label>
    <p class="file-state" role="status" data-image-selection-status></p>
    <label class="plan-check" data-replace-images hidden><input type="checkbox" /> Replace existing images with the new selection</label>
    <button type="button" class="link-button" data-clear-images hidden>Clear new selection</button>
    <div class="plan-render-strip" data-image-previews></div>`;
}

export function bindImagePicker(form: HTMLFormElement, limit: number) {
  const input = form.querySelector<HTMLInputElement>('input[name="images"]')!;
  const replaceLabel = form.querySelector<HTMLElement>("[data-replace-images]")!;
  const replace = replaceLabel.querySelector("input")!;
  const clear = form.querySelector<HTMLButtonElement>("[data-clear-images]")!;
  const strip = form.querySelector("[data-image-previews]")!;
  const status = form.querySelector("[data-image-selection-status]")!;
  let selection: Array<{ file: File; url: string }> = [];
  let savedUrls: string[] = [];
  let savedCount = 0;
  let previewVersion = 0;

  function render(): void {
    replaceLabel.hidden = !savedCount;
    clear.hidden = !selection.length;
    const urls = [...(replace.checked && selection.length ? [] : savedUrls), ...selection.map(({ url }) => url)];
    strip.replaceChildren(...urls.map((url, index) => {
      const img = new Image();
      img.src = url;
      img.alt = index === 0 ? "Cover image preview" : `Image ${index + 1} preview`;
      return img;
    }));
  }

  function reset(): void {
    selection.forEach(({ url }) => URL.revokeObjectURL(url));
    selection = [];
    replace.checked = false;
    status.textContent = "";
    render();
  }

  function validate(count: number): string {
    return count + (replace.checked && count ? 0 : savedCount) > limit ? `Choose up to ${limit} images in total.` : "";
  }

  input.addEventListener("change", () => {
    const files = Array.from(input.files ?? []);
    input.value = "";
    const invalid = files.some((file) => !Object.hasOwn(coverExtensions, file.type) || !file.size || file.size > maxCoverBytes);
    const error = invalid ? "Choose JPEG, PNG or WebP images of 5 MB each." : validate(selection.length + files.length);
    if (error) {
      status.textContent = `${error} The new selection was skipped.`;
      return;
    }
    selection.push(...files.map((file) => ({ file, url: URL.createObjectURL(file) })));
    status.textContent = `${selection.length} new image${selection.length === 1 ? "" : "s"} selected.`;
    render();
  });
  clear.addEventListener("click", () => { reset(); input.focus(); });
  replace.addEventListener("change", () => {
    status.textContent = validate(selection.length);
    render();
  });

  return {
    get files() { return selection.map(({ file }) => file); },
    get replace() { return replace.checked && selection.length > 0; },
    get count() { return selection.length + (this.replace ? 0 : savedCount); },
    get error() { return selection.length ? validate(selection.length) : ""; },
    setSaved(count: number, previews: Promise<string[]>) {
      const version = ++previewVersion;
      savedCount = count;
      savedUrls = [];
      reset();
      void previews.then((urls) => {
        if (version !== previewVersion || !form.isConnected) return;
        savedUrls = urls;
        render();
      }).catch(() => {});
    },
    dispose() { previewVersion++; reset(); }
  };
}
