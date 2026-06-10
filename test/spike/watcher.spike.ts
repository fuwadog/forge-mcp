/**
 * M0 Spike: @parcel/watcher under Bun
 *
 * Tests:
 * 1. subscribe() — watch fixture dir, touch a file, assert event within 2s
 * 2. unsubscribe() — clean exit
 *
 * Pass: event received within 2s, clean unsubscribe
 * Fail: no event within 2s, or unsubscribe throws
 */

import watcher from "@parcel/watcher";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures");
const TOUCH_FILE = join(FIXTURE_DIR, "_watcher_spike_touch.txt");

console.log("=== @parcel/watcher Spike ===");
console.log(`Watching: ${FIXTURE_DIR}`);

// --- Test 1: subscribe + touch + event ---
console.log("\n[Test 1] subscribe() → touch file → event within 2s");

let eventReceived = false;
let receivedEvents: watcher.Event[] = [];

const callback: watcher.SubscribeCallback = (err, events) => {
  if (err) {
    console.error("  Watcher error:", err);
    return;
  }
  receivedEvents = events;
  eventReceived = true;
  console.log(`  Received ${events.length} event(s):`);
  for (const ev of events) {
    console.log(`    ${ev.type}: ${ev.path}`);
  }
};

let sub: watcher.AsyncSubscription;
try {
  sub = await watcher.subscribe(FIXTURE_DIR, callback, {
    ignore: ["**/node_modules/**", "**/.git/**"],
  });
  console.log("  ✓ Subscribed");
} catch (e) {
  console.error("  ✗ subscribe() FAILED:", e);
  process.exit(1);
}

// Touch a file
try {
  writeFileSync(TOUCH_FILE, `spike-${Date.now()}`);
  console.log(`  Touched: ${TOUCH_FILE}`);
} catch (e) {
  console.error("  ✗ writeFileSync() FAILED:", e);
  await sub.unsubscribe();
  process.exit(1);
}

// Wait up to 2s for event
console.log("  Waiting for event (max 2s)...");
const deadline = Date.now() + 2000;
while (!eventReceived && Date.now() < deadline) {
  await Bun.sleep(50);
}

// Cleanup touch file
try {
  unlinkSync(TOUCH_FILE);
} catch {
  // ignore
}

if (!eventReceived) {
  console.error("  ✗ No event received within 2s");
  await sub.unsubscribe();
  process.exit(1);
}

console.log("  ✓ Event received");

// --- Test 2: unsubscribe ---
console.log("\n[Test 2] unsubscribe()");
try {
  await sub.unsubscribe();
  console.log("  ✓ Unsubscribed cleanly");
} catch (e) {
  console.error("  ✗ unsubscribe() FAILED:", e);
  process.exit(1);
}

console.log("\n=== All spike tests PASSED ===");
