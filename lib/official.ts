// The official Laybell account (@laybell). It's an operator-owned brand account
// (see supabase/sql/_OWNER_official_accounts.sql) whose stories are pinned into
// EVERY user's story tray regardless of follow — the way Instagram surfaces its
// own — so an announcement reaches the whole app, not just @laybell's followers.
//
// Hard-coded by id (stable across a username change) rather than resolved by
// username each load. If the brand account is ever recreated, update this id.
export const LAYBELL_OFFICIAL_USER_ID = '0ca340d6-2d95-4038-88da-4a3dc9b5b9fd';
