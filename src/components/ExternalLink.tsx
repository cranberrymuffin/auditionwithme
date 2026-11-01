import type { ReactNode } from "react";

type Props = {
  href: string;
  children: ReactNode;
};

// A link that opens in a new tab, so following it (e.g. to the Terms from
// the signup checkbox) doesn't lose what's been typed in the form.
export default function ExternalLink({ href, children }: Props) {
  return (
    <a className="external-link" href={href} target="_blank" rel="noopener">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
