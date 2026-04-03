#!/usr/bin/env node

const required = [
  'EXPO_PUBLIC_TURN_SERVER',
  'EXPO_PUBLIC_TURN_USERNAME',
  'EXPO_PUBLIC_TURN_PASSWORD',
];

const optionalBackup = [
  'EXPO_PUBLIC_TURN_SERVER_2',
  'EXPO_PUBLIC_TURN_USERNAME_2',
  'EXPO_PUBLIC_TURN_PASSWORD_2',
];

const missing = required.filter((k) => !process.env[k] || String(process.env[k]).trim() === '');

if (missing.length > 0) {
  console.error('CALL RELIABILITY CHECK FAILED');
  console.error('Missing required TURN env vars:');
  for (const key of missing) console.error(`- ${key}`);
  process.exit(1);
}

const relay = process.env.EXPO_PUBLIC_CALL_FORCE_RELAY;
const requireCustom = process.env.EXPO_PUBLIC_CALL_REQUIRE_CUSTOM_TURN;

console.log('CALL RELIABILITY CHECK PASSED');
console.log(`Primary TURN: ${process.env.EXPO_PUBLIC_TURN_SERVER}`);
console.log(`Relay Forced: ${relay ?? '(not set)'}`);
console.log(`Require Custom TURN: ${requireCustom ?? '(not set)'}`);

const backupSet = optionalBackup.filter((k) => !!process.env[k] && String(process.env[k]).trim() !== '');
if (backupSet.length === optionalBackup.length) {
  console.log(`Backup TURN: ${process.env.EXPO_PUBLIC_TURN_SERVER_2}`);
} else {
  console.warn('Backup TURN not fully configured (recommended for failover).');
}
