// Joining class names, and nothing more.
//
// The app this grew in used clsx + tailwind-merge, neither of which a library
// should force on a consumer — and a merge that understands Tailwind's utility
// names would be actively wrong here, because the package deliberately ships no
// Tailwind classes at all. Sizing is the host's; see `.relayed-avatar` in the
// stylesheet for the one thing the package does insist on.
export function classes(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
