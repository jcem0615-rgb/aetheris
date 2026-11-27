-- Applied to the live project on 2026-11-27.
--
-- phone_in_use answered "is this mobile number registered here?" to anyone at
-- all, signed in or not, over /rest/v1/rpc/phone_in_use. On a real-money
-- gambling site that lets a stranger walk a range of Philippine mobile numbers
-- and learn which of them gamble. Under RA 10173 that is personal data, and the
-- endpoint had no rate limit.
--
-- It was never load-bearing: profiles_phone_unique already enforces one account
-- per normalised number inside handle_new_user, so a duplicate rolls the whole
-- signup back regardless. The RPC only produced a friendlier message slightly
-- earlier, and the client already handles both the constraint name and the
-- generic database error with a clear sentence.
revoke execute on function public.phone_in_use(text) from public, anon, authenticated;

comment on function public.phone_in_use(text) is
  'Service-role only. Deliberately not granted to anon/authenticated: it would answer whether any given mobile number is registered. Uniqueness is enforced by profiles_phone_unique, not by this.';
