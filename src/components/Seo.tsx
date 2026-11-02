import { useEffect } from "react";

export const SITE_URL = "https://www.auditionwithme.com";
export const SITE_NAME = "AuditionWithMe";
const DEFAULT_OG_IMAGE = "/images/hollywood-hills-hero-wide.png";

type SeoProps = {
  title: string;
  description: string;
  /** Route path, e.g. "/pricing" — used for canonical and og:url. */
  path: string;
  /** Root-relative image path; defaults to the hero image. */
  image?: string;
  /** Set on pages that require auth or shouldn't be indexed. */
  noindex?: boolean;
};

export type ResolvedSeo = {
  title: string;
  description: string;
  url: string;
  image: string;
  noindex: boolean;
};

function resolveSeo({ title, description, path, image, noindex = false }: SeoProps): ResolvedSeo {
  return {
    title: path === "/" ? title : `${title} | ${SITE_NAME}`,
    description,
    url: `${SITE_URL}${path}`,
    image: `${SITE_URL}${image ?? DEFAULT_OG_IMAGE}`,
    noindex,
  };
}

/** Filled during the build-time prerender (src/entry-server.tsx), where
 * effects never run, so it can write each page's head tags into its HTML. */
export const ssrSeo: { current: ResolvedSeo | null } = { current: null };

function setMetaByName(name: string, content: string) {
  let tag = document.querySelector(`meta[name="${name}"]`);
  if (!tag) {
    tag = document.createElement("meta");
    tag.setAttribute("name", name);
    document.head.appendChild(tag);
  }
  tag.setAttribute("content", content);
}

function setMetaByProperty(property: string, content: string) {
  let tag = document.querySelector(`meta[property="${property}"]`);
  if (!tag) {
    tag = document.createElement("meta");
    tag.setAttribute("property", property);
    document.head.appendChild(tag);
  }
  tag.setAttribute("content", content);
}

function setCanonical(url: string) {
  let link = document.querySelector('link[rel="canonical"]');
  if (!link) {
    link = document.createElement("link");
    link.setAttribute("rel", "canonical");
    document.head.appendChild(link);
  }
  link.setAttribute("href", url);
}

/**
 * Updates document title, meta tags, and canonical link for the current
 * route. Exposed as a hook (rather than only a component) so pages with
 * several early-return branches — e.g. Practice.tsx's parsing/casting/
 * rehearsal states — can call it once at the top and have it apply
 * regardless of which branch actually renders.
 */
export function useSeo({
  title,
  description,
  path,
  image,
  noindex = false,
}: SeoProps) {
  if (typeof document === "undefined") {
    ssrSeo.current = resolveSeo({ title, description, path, image, noindex });
  }

  useEffect(() => {
    const { title: fullTitle, url, image: ogImage } = resolveSeo({
      title,
      description,
      path,
      image,
      noindex,
    });

    document.title = fullTitle;

    setMetaByName("description", description);
    setMetaByName("robots", noindex ? "noindex, nofollow" : "index, follow");

    setMetaByProperty("og:title", fullTitle);
    setMetaByProperty("og:description", description);
    setMetaByProperty("og:type", "website");
    setMetaByProperty("og:url", url);
    setMetaByProperty("og:image", ogImage);
    setMetaByProperty("og:site_name", SITE_NAME);

    setMetaByName("twitter:card", "summary_large_image");
    setMetaByName("twitter:title", fullTitle);
    setMetaByName("twitter:description", description);
    setMetaByName("twitter:image", ogImage);

    setCanonical(url);
  }, [title, description, path, image, noindex]);
}

export default function Seo(props: SeoProps) {
  useSeo(props);
  return null;
}
