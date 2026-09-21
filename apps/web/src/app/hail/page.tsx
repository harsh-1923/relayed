import type { Metadata } from "next";
import { readHailMark } from "@/lib/hail-mark";

export const metadata: Metadata = {
  title: "Hail",
  description: "Human Agent Interaction Labs",
};

export default async function HailPage() {
  const markContents = await readHailMark();

  return (
    <main className="relative isolate grid min-h-dvh flex-1 place-items-center overflow-hidden bg-[#1347f5] p-8">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 221 226"
        fill="none"
        role="img"
        aria-label="Human Agent Interaction Labs"
        className="pointer-events-none relative z-10 h-auto w-[min(54vmin,24rem)]"
        dangerouslySetInnerHTML={{ __html: markContents }}
      />
    </main>
  );
}
