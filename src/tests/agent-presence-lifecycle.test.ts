import assert from 'node:assert/strict';
import { DEFAULT_AGENT_PRESENCE_TTL_MS, getAgentPresenceDisplay } from '../shared/agent-presence.js';

const start = Date.parse('2026-09-15T12:00:00Z');
const entry = { at: new Date(start).toISOString(), status: 'editing' };
assert.equal(DEFAULT_AGENT_PRESENCE_TTL_MS, 900_000);
assert.deepEqual(getAgentPresenceDisplay(entry, start + 59_999), {
  visible: true, idle: false, label: 'active now', nextUpdateAtMs: start + 60_000,
});
assert.deepEqual(getAgentPresenceDisplay(entry, start + 60_000), {
  visible: true, idle: true, label: 'last active 1 min ago', nextUpdateAtMs: start + 120_000,
});
assert.equal(getAgentPresenceDisplay(entry, start + 360_000).label, 'last active 6 min ago');
assert.equal(getAgentPresenceDisplay(entry, start + 899_999).visible, true);
assert.equal(getAgentPresenceDisplay(entry, start + 900_000).visible, false);
const refreshed = { ...entry, at: new Date(start + 360_000).toISOString() };
assert.equal(getAgentPresenceDisplay(refreshed, start + 360_000).idle, false);
assert.equal(getAgentPresenceDisplay(refreshed, start + 900_000).visible, true);
assert.equal(getAgentPresenceDisplay({ ...entry, status: 'left' }, start).visible, false);
assert.equal(getAgentPresenceDisplay({ ...entry, status: 'disconnected' }, start).visible, false);
for (const ttl of [500, 1_800_000]) {
  const configured = { ...entry, expiresAt: new Date(start + ttl).toISOString() };
  assert.equal(getAgentPresenceDisplay(configured, start + ttl - 1).visible, true);
  assert.equal(getAgentPresenceDisplay(configured, start + ttl).visible, false);
}
console.log('✓ agent presence idle, expiry, reactivation, leave and configured TTL');
