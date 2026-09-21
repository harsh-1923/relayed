import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function readHailMark() {
  // Only bundled artwork enters the SVG markup, never a request or user input.
  const exportedMark = await readFile(join(process.cwd(), "public", "hail-mark.svg"), "utf8");
  return exportedMark
    .replace(/^<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .replace(/<rect\b[^>]*\/>/g, "")
    .replace(/\s+id="[^"]*"/g, "");
}
