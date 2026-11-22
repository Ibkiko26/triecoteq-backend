export const frontendRepository = "Ibkiko26/triecoteq-frontend";
export const frontendBranch = "main";
export const frontendWebsite = "https://triecoteq-frontend.vercel.app";
export const portfolioFile = "content/portfolio.json";
export const coverBucket = "portfolio-draft-covers";
export const maxCoverBytes = 5 * 1024 * 1024;

export const coverExtensions = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp"
} as const;

export const projectIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const draftIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const categories = ["Residential", "Interior", "Commercial", "Institutional", "Hospitality", "Mixed-use", "Civic", "Landscape", "Industrial"];

export interface PublishedProject {
  id: string;
  title: string;
  category: string;
  location: string;
  year: string;
  description: string;
  priceLabel: string;
  image: string;
}

export interface DraftFields {
  project_id: string;
  title: string;
  category: string;
  location: string;
  year: string;
  description: string;
  price_label: string;
}

export interface ProjectDraft extends DraftFields {
  id: string;
  cover_path: string | null;
  source_image: string | null;
  revision: number;
  published_revision: number | null;
  published_commit: string | null;
  updated_at: string;
}

export function projectImagePath(path: string): boolean {
  return /^(?:admin\/portfolio-library|assets\/(?:portfolio|hero))\/[a-z0-9_ .-]+\.(?:jpe?g|png|webp)$/i.test(path)
    && !path.includes("..");
}

export function publishedData(draft: DraftFields, image: string): PublishedProject {
  return {
    id: draft.project_id,
    title: draft.title.trim(),
    category: draft.category.trim(),
    location: draft.location.trim(),
    year: draft.year,
    description: draft.description.trim(),
    priceLabel: draft.price_label.trim(),
    image
  };
}

export function matchesPublished(project: PublishedProject, expected: PublishedProject): boolean {
  return (Object.keys(expected) as Array<keyof PublishedProject>).every((key) => project[key] === expected[key]);
}
