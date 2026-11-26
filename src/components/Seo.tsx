import { useSeo, type SeoProps } from "../lib/seo";

export default function Seo(props: SeoProps) {
  useSeo(props);
  return null;
}
