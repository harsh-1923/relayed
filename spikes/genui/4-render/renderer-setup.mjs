import { z } from 'zod/v4';
// Must evaluate before @openuidev/react-lang: its module body auto-mounts
// devtools in development, and devtools loads its UI from cdn.jsdelivr.net.
globalThis[Symbol.for("openui.devtools.autoMount")] = true;
// Zod v4 probes `new Function` to decide whether to compile validators. Relayed's
// CSP has no 'unsafe-eval', so the probe is reported as a violation even though
// it is caught. jitless skips the probe.
z.config({ jitless: true });
