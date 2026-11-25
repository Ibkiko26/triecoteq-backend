# triecoteq-backend

Backend infrastructure for Tri-EcoTeq Architects, powered by Supabase PostgreSQL, Authentication, and Storage.

## Project enquiries

`api/submit-inquiry.js` handles enquiries through the Supabase `submit-inquiry` Edge Function. The endpoint accepts a JSON `POST` at `/functions/v1/submit-inquiry` with `name`, `email`, optional `service`, and `message`. It returns `201` after Airtable accepts the record.

Set these values in the Supabase project’s [Edge Function secrets](https://supabase.com/docs/guides/functions/secrets):

- `AIRTABLE_TOKEN` is a personal access token with `data.records:write` scoped to the enquiry base.
- `AIRTABLE_BASE_ID` is the enquiry base ID.
- `AIRTABLE_TABLE_ID` is the enquiry table ID.
- `INQUIRY_ALLOWED_ORIGINS` is an optional, comma-separated list of exact website origins for direct browser requests. Requests from a server can omit the Origin header.

The Airtable table needs `Name` (single-line text), `Email` (email), and `Message` (long text) fields. If the table has no `Service` field, set the `AIRTABLE_SERVICE_IN_MESSAGE` Edge Function secret to `true` to include the selected service in the message.

Deploy the function from the repository root with the Supabase CLI.

```sh
supabase functions deploy submit-inquiry --project-ref <project-ref>
```


## Portfolio admin

The admin site runs on any static host that supports a Vite build. Use `npm ci`, build with `npm run build`, and serve `dist/`. To preview locally, set the two values from `.env.example` in `.env.local` and run `npm run dev`. The browser uses the Supabase project URL and publishable key.

### Connect Supabase

1. Link the checkout to your Supabase project and apply the migration with `supabase db push`.
2. Create each administrator in Supabase Authentication with a confirmed email and a password. Grant the account portfolio access in the SQL Editor.

```sql
insert into public.portfolio_admins (user_id)
select id from auth.users
where lower(email) = lower('admin@example.com')
on conflict do nothing;
```

Use the administrator’s email in the query. New members receive portfolio access by default. Set `can_manage_plans` to `true` on their `portfolio_admins` row to grant access to Ready-made plans. Remove their row to revoke workspace access.

3. In [Edge Function secrets](https://supabase.com/docs/guides/functions/secrets), set `FRONTEND_GITHUB_TOKEN` to a GitHub fine-grained token restricted to `Ibkiko26/triecoteq-frontend` with **Contents: Read and write**.
4. Deploy the `publish-portfolio` Edge Function.

```sh
supabase functions deploy publish-portfolio --project-ref <project-ref>
```

The function verifies the signed-in user’s admin membership before using the GitHub token. The token belongs in Supabase secrets. The admin site only needs the publishable key.

### Edit and publish projects

Use **New project** to enter a title, project ID, category, location, year, description and optional price label. Upload up to six JPEG, PNG or WebP images of 5 MB each. The first image is the cover. To change a project’s ID or images, open **Published portfolio** and select **Edit**. New images append to the gallery unless you select **Replace existing images**.

**Publish to website** saves the draft and commits the gallery to the frontend repository’s `main` branch. When you change a project ID, publishing updates the same entry. The dashboard links to the commit after it is accepted. Visitors see the change after the frontend deployment finishes.

Publish projects from this workspace so the GitHub-backed portfolio file stays current. The existing enquiry Edge Function uses its own Airtable settings.


## Ready-made plans

Apply the ready-made plans migration with `supabase db push`, then deploy the `manage-plans` Edge Function. Plan administrators sign in with Supabase and need `can_manage_plans` enabled. Publishing uses the same `FRONTEND_GITHUB_TOKEN` as portfolio publishing. The new frontend build reads the published plan catalogue and its demo PDFs.

```sh
supabase functions deploy manage-plans --project-ref <project-ref>
```

- Open **Ready-made plans** in the admin navigation. Create a plan or edit an existing listing via **Website catalogue**.
- Upload up to six public renders across one or more selections and an optional separate sample PDF. Select **Replace existing images** if you want the new renders to replace the existing gallery. Upload the full drawing PDF in **Buyer-only download**. A published plan must have at least one render and a drawing PDF.
- **Publish plan** sends the listing, renders and sample PDF to the frontend repository. The full PDF stays in Supabase’s private `private-plan-files` bucket.
- The public checkout still sends an enquiry. After verifying payment outside the site, open **Download access**, enter the buyer’s email and payment reference, and issue a link. Copy it to the buyer. The link opens the admin host’s buyer download page and expires after seven days.
- Admins can revoke an issued link from the plan. A storage URL already prepared by a buyer expires in at most 60 seconds. Existing links continue to point to the drawing revision purchased.
