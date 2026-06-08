# MongoDB → Supabase Migration Guide

## Current MongoDB data (dry-run verified)

| Collection       | Documents |
|------------------|-----------|
| admins           | 2         |
| settings         | 1         |
| delivery_zones   | 4         |
| users            | 2         |
| drivers          | 2         |
| pricings         | 3         |
| orders           | 4         |
| notifications    | 19        |
| otps / payments  | 0         |
| **TOTAL**        | **37**    |

MongoDB `_id` values are preserved as TEXT primary keys — apps will continue to work without ID changes.

---

## Step 1 — Create Supabase project

1. Go to [supabase.com](https://supabase.com) → New Project
2. Note your **Project URL** and **Service Role Key** (Settings → API)

## Step 2 — Run schema SQL

1. Open Supabase Dashboard → **SQL Editor**
2. Paste and run the entire contents of `backend/supabase/schema.sql`
3. Confirm all 11 tables are created (10 data tables + `migration_meta`)

## Step 3 — Add credentials to `.env`

Add these lines to `backend/.env`:

```env
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

> **Important:** Use the **service role key** for migration (not anon key). Never commit this key to git.

## Step 4 — Run migration

```bash
cd backend

# Optional: preview counts again
npm run migrate:dry-run

# Live migration (writes to Supabase)
npm run migrate:supabase

# Verify counts match
npm run migrate:verify
```

## Step 5 — Confirm zero data loss

`migrate:verify` must show ✅ for all 10 collections.  
`migration_meta` table in Supabase will also log each run.

---

## What is NOT migrated (by design)

| Item | Reason |
|------|--------|
| R2 file uploads | Already in Cloudflare R2, URLs stored in DB |
| Redis geo index | Rebuilt when drivers go online after cutover |
| Expired OTPs | TTL auto-deleted in MongoDB; only active OTPs matter |

---

## After migration

**Backend now reads/writes Supabase** via the compatibility layer in `backend/db/`.  
MongoDB is only used by migration scripts (`npm run migrate:*`), not by the live API.

Restart the backend server after pulling these changes:
```bash
cd backend && npm start
```
