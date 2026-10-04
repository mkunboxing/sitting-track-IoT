import { getSupabaseServerClient } from './supabase';
import { hashPassword, verifyPassword } from './auth';

/**
 * Device registry + ownership linking.
 *
 * The Arduino NEVER uses any of this — it keeps authenticating at the EMQX
 * broker and is identified by its device_id (MQTT topic segment), exactly as
 * before. This module is purely the user-side directory: which dashboard
 * account may see which device's sitting data.
 *
 * A devices row with user_id null is UNLINKED: its sessions (user_id null)
 * are visible in nobody's dashboard. The telemetry pipeline stamps new
 * sessions with the owner's user_id at open time (see getDeviceOwnerUserId +
 * sessionService.openSession).
 */

/** Same charset the firmware uses — must stay a safe MQTT topic segment. */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function isValidDeviceId(deviceId: string): boolean {
  return DEVICE_ID_PATTERN.test(deviceId);
}

/** user_id of the account a device is linked to, or null (unlinked/unknown). */
export async function getDeviceOwnerUserId(deviceId: string): Promise<string | null> {
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from('devices')
    .select('user_id')
    .eq('device_id', deviceId)
    .maybeSingle();

  if (error) {
    console.error(`[DEVICES] Owner lookup failed for ${deviceId}:`, error.message);
    return null;
  }
  return data?.user_id ?? null;
}

/** All device_ids linked to a user (empty when they have none). */
export async function getUserDeviceIds(userId: string): Promise<string[]> {
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from('devices')
    .select('device_id')
    .eq('user_id', userId);

  if (error) {
    console.error(`[DEVICES] Device list failed for user ${userId}:`, error.message);
    return [];
  }
  return (data ?? []).map((row) => row.device_id);
}

export interface TrackerDeviceRow {
  id: string;
  device_id: string;
  name: string;
  created_at: string;
}

export async function listDevicesForUser(userId: string): Promise<TrackerDeviceRow[]> {
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from('devices')
    .select('id, device_id, name, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error(`[DEVICES] Device list failed for user ${userId}:`, error.message);
    return [];
  }
  return data ?? [];
}

export type LinkDeviceResult =
  | { status: 'linked'; device: TrackerDeviceRow }
  | { status: 'already_linked'; device: TrackerDeviceRow }
  | { status: 'taken' }
  | { status: 'invalid_secret' }
  | { status: 'invalid_device_id' }
  | { status: 'db_error'; error: string };

/**
 * Link a device to a user ("Connect Device" flow).
 *
 * - Unknown device_id → registered and linked to this user (first claim wins).
 * - Already linked to this user → already_linked.
 * - Linked to ANOTHER user → taken (rejected; must be unlinked first).
 * - Unlinked → linked, but only when the stored device PIN (device_secret)
 *   is absent or matches the provided secret.
 *
 * On a successful link the device's currently-active sitting session (if any
 * was opened while the device was unlinked) is retroactively assigned to the
 * user so it appears on their dashboard immediately.
 */
export async function linkDevice(
  userId: string,
  deviceId: string,
  secret?: string,
  name?: string
): Promise<LinkDeviceResult> {
  if (!isValidDeviceId(deviceId)) return { status: 'invalid_device_id' };

  const supabase = getSupabaseServerClient();

  try {
    const { data: existing, error: fetchError } = await supabase
      .from('devices')
      .select('id, device_id, user_id, name, device_secret, created_at')
      .eq('device_id', deviceId)
      .maybeSingle();

    if (fetchError) return { status: 'db_error', error: fetchError.message };

    const friendlyName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 64) : null;

    if (existing) {
      if (existing.user_id === userId) {
        return {
          status: 'already_linked',
          device: { id: existing.id, device_id: existing.device_id, name: existing.name, created_at: existing.created_at },
        };
      }
      if (existing.user_id !== null) return { status: 'taken' };

      // Unlinked device: claim requires its PIN when one is stored
      if (existing.device_secret) {
        const ok =
          typeof secret === 'string' &&
          secret.length > 0 &&
          (await verifyPassword(secret, existing.device_secret));
        if (!ok) return { status: 'invalid_secret' };
      }

      const { data: updated, error: updateError } = await supabase
        .from('devices')
        .update({ user_id: userId, ...(friendlyName ? { name: friendlyName } : {}) })
        .eq('id', existing.id)
        .select('id, device_id, name, created_at')
        .single();

      if (updateError) return { status: 'db_error', error: updateError.message };

      await backfillActiveSessionOwner(supabase, deviceId, userId);
      return { status: 'linked', device: updated };
    }

    // First claim of an unknown device_id — register + link. A secret provided
    // here is stored (hashed) so releasing and re-claiming later requires it.
    const { data: created, error: insertError } = await supabase
      .from('devices')
      .insert({
        device_id: deviceId,
        user_id: userId,
        name: friendlyName ?? 'Desk Sensor',
        device_secret:
          typeof secret === 'string' && secret.length > 0 ? await hashPassword(secret) : null,
      })
      .select('id, device_id, name, created_at')
      .single();

    if (insertError) {
      // Lost a claim race (unique index) — re-read and report honestly
      if (insertError.code === '23505') return { status: 'taken' };
      return { status: 'db_error', error: insertError.message };
    }

    return { status: 'linked', device: created };
  } catch (err: unknown) {
    return { status: 'db_error', error: String(err) };
  }
}

export type UnlinkDeviceResult =
  | { status: 'unlinked' }
  | { status: 'not_owned' }
  | { status: 'db_error'; error: string };

/**
 * Release a device from the user's account (the row stays registered so a
 * stored PIN keeps protecting future claims). Only the owner can unlink.
 */
export async function unlinkDevice(userId: string, deviceId: string): Promise<UnlinkDeviceResult> {
  if (!isValidDeviceId(deviceId)) return { status: 'not_owned' };

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from('devices')
    .update({ user_id: null })
    .eq('device_id', deviceId)
    .eq('user_id', userId)
    .select('id');

  if (error) return { status: 'db_error', error: error.message };
  return (data ?? []).length > 0 ? { status: 'unlinked' } : { status: 'not_owned' };
}

/** Assign the device's still-open session (opened while unlinked) to its new owner. */
async function backfillActiveSessionOwner(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  deviceId: string,
  userId: string
): Promise<void> {
  const { data, error } = await supabase
    .from('sitting_sessions')
    .update({ user_id: userId })
    .eq('device_id', deviceId)
    .is('ended_at', null)
    .is('user_id', null)
    .select('id');

  if (error) {
    console.error(`[DEVICES] Active-session backfill failed for ${deviceId}:`, error.message);
    return;
  }
  if ((data ?? []).length > 0) {
    console.log(`[DEVICES] ${deviceId}: assigned its active session to user ${userId}`);
  }
}
