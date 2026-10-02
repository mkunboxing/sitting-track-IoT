import { createClient } from '@supabase/supabase-js';

export const getFormattedSupabaseUrl = (): string | undefined => {
  let url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)?.trim();
  if (!url) return undefined;
  // Remove surrounding quotes if any
  url = url.replace(/^['"](.*)['"]$/, '$1').trim();
  if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://${url}`;
  }
  return url;
};

export const isSupabaseConfigured = (): boolean => {
  const url = getFormattedSupabaseUrl();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return (
    !!url &&
    !!key &&
    !url.includes('placeholder-project') &&
    !key.includes('placeholder_service_role_key')
  );
};

export const getSupabaseServerClient = () => {
  const url = getFormattedSupabaseUrl();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^['"](.*)['"]$/, '$1');

  if (!url || !serviceRoleKey) {
    throw new Error(
      'Missing Supabase credentials. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your environment.'
    );
  }

  // Create server-side Supabase client with service-role privileges
  // Bypasses Row Level Security (RLS) for secure backend API operations
  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
};
