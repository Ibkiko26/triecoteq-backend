import { coverExtensions, maxCoverBytes } from "../shared/portfolio";

type ImageType = keyof typeof coverExtensions;

async function imageType(file: File): Promise<ImageType | undefined> {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return "image/png";
  const decoder = new TextDecoder();
  if (decoder.decode(bytes.subarray(0, 4)) === "RIFF" && decoder.decode(bytes.subarray(8)) === "WEBP") return "image/webp";
}

async function optimize(file: File): Promise<File> {
  const image = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("could not be resized");
    for (const longestSide of [2400, 1800, 1200]) {
      const scale = Math.min(1, longestSide / Math.max(image.width, image.height));
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.88));
      if (blob && blob.size <= maxCoverBytes && Object.hasOwn(coverExtensions, blob.type)) {
        const extension = coverExtensions[blob.type as ImageType];
        const name = `${file.name.replace(/\.[^.]+$/, "")}.${extension}`;
        return new File([blob], name, { type: blob.type, lastModified: file.lastModified });
      }
    }
    throw new Error("could not be resized below 5 MB");
  } finally {
    image.close();
    canvas.width = canvas.height = 0;
  }
}

export async function prepareImage(file: File): Promise<{ file: File; optimized: boolean }> {
  if (!file.size) throw new Error("is empty");
  const type = await imageType(file);
  if (!type) throw new Error("must be a JPEG, PNG or WebP image");
  if (file.size <= maxCoverBytes) {
    return { file: file.type === type ? file : new File([file], file.name, { type, lastModified: file.lastModified }), optimized: false };
  }
  try {
    return { file: await optimize(file), optimized: true };
  } catch {
    throw new Error("could not be resized below 5 MB. Try a smaller copy");
  }
}
