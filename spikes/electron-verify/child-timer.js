// utilityProcess side of the throttling check. Reports every tick with the
// actual elapsed time, so main can compare against the renderer control.
const INTERVAL = Number(process.env.TICK_MS ?? 5000);
let last = Date.now(), n = 0;
setInterval(() => {
  const now = Date.now();
  process.parentPort.postMessage({ src: 'utility', n: ++n, dt: now - last });
  last = now;
}, INTERVAL);
process.parentPort.postMessage({ src: 'utility', ready: true, pid: process.pid });
