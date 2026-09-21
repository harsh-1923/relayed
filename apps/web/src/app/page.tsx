import type { Metadata } from "next";
import { DownloadButton } from "@/components/download-button";
import { HailLogoPanel } from "@/components/hail-logo-panel";
import { SiteFooter } from "@/components/site-footer";
import { readHailMark } from "@/lib/hail-mark";
import { HAIL_PRESETS } from "@/lib/hail-presets";

export const metadata: Metadata = {
  title: { absolute: "Relay — A shared space for humans and agents" },
  description: "Relay brings conversations, context, and AI agents together in a local-first workspace.",
};

export default async function Home() {
  const mark = await readHailMark();
  const monochromeMark = mark.replace(/(fill|stroke)="(?:#[\da-f]{6}|white)"/gi, '$1="currentColor"');
  const ember = HAIL_PRESETS.find((preset) => preset.name === "Ember")!;

  return (
    <>
      <main className="new-landing-page">
        <section aria-label="Relay introduction">
          <HailLogoPanel markContents={monochromeMark} settings={ember.settings}>
            <div className="grid items-end gap-7 md:grid-cols-[1fr_auto] md:gap-12">
              <div>
                <p className="max-w-xl text-[18px] leading-7 tracking-[-0.02em] opacity-80">
                  Conversations, context, and AI agents together in one local-first workspace.
                </p>
              </div>

              <div className="flex items-start md:justify-end">
                <DownloadButton />
              </div>
            </div>
          </HailLogoPanel>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
