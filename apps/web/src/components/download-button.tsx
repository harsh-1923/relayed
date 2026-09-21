"use client";

import { useState } from "react";
import { Check, Copy, Download } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DOWNLOAD_ARCH,
  DOWNLOAD_URL,
  UNQUARANTINE_COMMAND,
} from "@/lib/download";

export function DownloadButton() {
  const [showSteps, setShowSteps] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(UNQUARANTINE_COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // A blocked clipboard is not worth an error state — the command sits
      // right there as selectable text.
    }
  };

  return (
    <>
      {/* An anchor rather than a scripted button: the browser performs the
          download itself, so right-click-save and middle-click still behave,
          and a hydration failure cannot leave the page's only call to action
          inert. The dialog is the enhancement, not the mechanism. */}
      <a
        href={DOWNLOAD_URL}
        onClick={() => setShowSteps(true)}
        className="inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-white px-5 text-[13px] font-medium text-[#170c09] transition-opacity hover:opacity-90"
      >
        <Download size={15} aria-hidden="true" />
        Download Relay
        <span className="opacity-60">· macOS {DOWNLOAD_ARCH}</span>
      </a>

      <Dialog open={showSteps} onOpenChange={setShowSteps}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Your download has started</DialogTitle>
            <DialogDescription>
              Three steps to get it running. The third one is unusual — it is
              explained below.
            </DialogDescription>
          </DialogHeader>

          <ol className="grid gap-3 text-[13px] leading-6">
            <li className="grid grid-cols-[1.25rem_1fr] gap-2">
              <span className="opacity-50">1.</span>
              <span>
                Open the downloaded <code>.dmg</code> and drag{" "}
                <strong>Relayed</strong> into Applications.
              </span>
            </li>
            <li className="grid grid-cols-[1.25rem_1fr] gap-2">
              <span className="opacity-50">2.</span>
              <div className="grid gap-2">
                <span>Open Terminal and run:</span>
                <div className="flex items-center gap-2 rounded-lg bg-foreground/5 p-2">
                  <code className="flex-1 font-mono text-[12px] break-all select-all">
                    {UNQUARANTINE_COMMAND}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copyCommand()}
                    aria-label="Copy command"
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-foreground/10"
                  >
                    {copied ? (
                      <Check size={14} aria-hidden="true" />
                    ) : (
                      <Copy size={14} aria-hidden="true" />
                    )}
                  </button>
                </div>
              </div>
            </li>
            <li className="grid grid-cols-[1.25rem_1fr] gap-2">
              <span className="opacity-50">3.</span>
              <span>Open Relayed from Applications.</span>
            </li>
          </ol>

          {/* Said before they hit it, not after. Someone who meets "damaged"
              with no warning concludes the download is broken and bins it. */}
          <p className="text-[12px] leading-5 opacity-70">
            Step 2 is needed because this build is not signed by Apple yet.
            Without it macOS claims the app is <em>damaged</em> — it is not, and
            that message is simply what an unsigned app looks like. Signing is in
            progress and this step will disappear.
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
