// Runs before anything imports @openuidev/react-lang — main.tsx imports it first
// for that reason (docs/AGENT-RESPONSES.md, renderer setup).
//
// Both lines were found by rendering under this app's CSP, not by reading:
//
// 1. react-lang's module body auto-mounts OpenUI's devtools in a development
//    build, and the devtools load their UI from cdn.jsdelivr.net. The CSP blocks
//    the script, but the attempt is still an outbound request this renderer is
//    meant never to make (the CSP note in index.html). Setting the flag first
//    makes react-lang skip the mount.
//
// 2. Zod 4 probes `new Function` to decide whether it may compile validators.
//    There is no 'unsafe-eval' here, so the probe is reported as a CSP violation
//    even though Zod catches it. `jitless` skips the probe.
import { z } from 'zod';

(globalThis as Record<symbol, unknown>)[Symbol.for('openui.devtools.autoMount')] = true;
z.config({ jitless: true });
