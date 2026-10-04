/**
 * One-time data migration: user accounts + device linking.
 * Run from backend/ AFTER the SQL migration
 * (supabase/migrations/20261004000000_auth_users_devices.sql) has been applied:
 *
 *   npx tsx --env-file=.env scripts/migrate-auth.ts
 *
 * What it does (idempotent — safe to run again):
 *   1. Creates the default test/admin account (ADMIN_USERNAME / ADMIN_PASSWORD,
 *      default admin / admin123 — bcrypt-hashed like every password; the
 *      plaintext is never stored). Existing accounts are left untouched.
 *   2. Assigns ALL existing sitting sessions (user_id is null) to the admin
 *      account and tags them with the device id — nothing is deleted, and the
 *      admin dashboard keeps showing the full history exactly as before.
 *   3. Registers + links the Arduino (DEVICE_ID, default sitting-tracker-01 —
 *      same id the firmware publishes to MQTT with) to the admin account, so
 *      its new sessions keep flowing to the admin dashboard.
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { getSupabaseServerClient, isSupabaseConfigured } from '../src/lib/supabase.js';

const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DEVICE_ID = (process.env.DEVICE_ID || 'sitting-tracker-01').trim();

async function main(): Promise<void> {
  if (!isSupabaseConfigured()) {
    console.error('✗ Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend/.env');
    process.exit(1);
  }
  const supabase = getSupabaseServerClient();

  // 0. Make sure the SQL migration ran (users table must exist)
  const probe = await supabase.from('users').select('id').limit(1);
  if (probe.error) {
    console.error('✗ The "users" table is missing. Apply the SQL migration FIRST:');
    console.error('    supabase/migrations/20261004000000_auth_users_devices.sql');
    console.error(`  (Supabase said: ${probe.error.message})`);
    process.exit(1);
  }

  // 1. Default test/admin account (never overwrite an existing one)
  console.log(`\n[1/3] Admin account (${ADMIN_USERNAME})`);
  // ilike is only a pre-filter (it treats "_" as a wildcard); exact-match here
  const { data: adminCandidates } = await supabase
    .from('users')
    .select('id, username')
    .ilike('username', ADMIN_USERNAME)
    .limit(20);
  const existingAdmin = (adminCandidates ?? []).find(
    (row: { username: string }) => row.username.toLowerCase() === ADMIN_USERNAME.toLowerCase()
  ) ?? null;

  let adminId: string;
  if (existingAdmin) {
    adminId = existingAdmin.id;
    console.log(`  = already exists (${existingAdmin.id}) — left untouched`);
  } else {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const { data: created, error } = await supabase
      .from('users')
      .insert({ username: ADMIN_USERNAME, password_hash: passwordHash })
      .select('id, username')
      .single();
    if (error) {
      console.error(`  ✗ Failed to create admin account: ${error.message}`);
      process.exit(1);
    }
    adminId = created.id;
    console.log(`  ✓ created (${created.id})`);
    if (!process.env.ADMIN_PASSWORD) {
      console.log('  ⚠ default password "admin123" used — set ADMIN_PASSWORD in backend/.env to choose your own.');
    }
  }

  // 2. Assign every existing sitting session to the admin account
  console.log('\n[2/3] Existing sitting sessions');
  const { data: assigned, error: assignError } = await supabase
    .from('sitting_sessions')
    .update({ user_id: adminId, device_id: DEVICE_ID })
    .is('user_id', null)
    .select('id');

  if (assignError) {
    console.error(`  ✗ Failed to assign sessions: ${assignError.message}`);
    process.exit(1);
  }
  console.log(`  ✓ ${assigned?.length ?? 0} existing session(s) assigned to ${ADMIN_USERNAME} (user_id was null) — nothing deleted`);

  // 3. Register + link the Arduino to the admin account
  console.log(`\n[3/3] Device linking (${DEVICE_ID})`);
  const { data: device } = await supabase
    .from('devices')
    .select('id, device_id, user_id')
    .eq('device_id', DEVICE_ID)
    .maybeSingle();

  if (!device) {
    const { error } = await supabase
      .from('devices')
      .insert({ device_id: DEVICE_ID, user_id: adminId, name: 'Desk Sensor' });
    if (error) {
      console.error(`  ✗ Failed to register device: ${error.message}`);
      process.exit(1);
    }
    console.log(`  ✓ registered and linked to ${ADMIN_USERNAME}`);
  } else if (device.user_id === adminId) {
    console.log('  = already linked to the admin account');
  } else if (device.user_id === null) {
    const { error } = await supabase
      .from('devices')
      .update({ user_id: adminId })
      .eq('id', device.id);
    if (error) {
      console.error(`  ✗ Failed to link device: ${error.message}`);
      process.exit(1);
    }
    console.log(`  ✓ linked to ${ADMIN_USERNAME}`);
  } else {
    console.log(`  ⚠ already linked to another user (${device.user_id}) — left untouched`);
  }

  console.log('\nDone. Log in on the dashboard with the admin account; new users can sign up and link their own devices.');
}

main().catch((err: unknown) => {
  console.error('✗ Migration failed:', err);
  process.exit(1);
});
