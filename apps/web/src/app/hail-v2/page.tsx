import type { Metadata } from "next";
import { HailTuner } from "@/components/hail-tuner";
import { readHailMark } from "@/lib/hail-mark";

export const metadata: Metadata = {
  title: "Hail — Color studies",
  description: "Explore color and motion for Human Agent Interaction Labs.",
};

export default async function HailV2Page() {
  const mark = await readHailMark();
  const monochromeMark = mark.replace(/(fill|stroke)="(?:#[\da-f]{6}|white)"/gi, '$1="currentColor"');
  return <HailTuner markContents={monochromeMark} />;
}
