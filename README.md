# triecoteq-backend

Backend infrastructure for Tri-EcoTeq Architects, powered by Supabase PostgreSQL, Authentication, and Storage.

## Project enquiries

`api/submit-inquiry.js` handles enquiries through the Supabase `submit-inquiry` Edge Function. The endpoint accepts a JSON `POST` at `/functions/v1/submit-inquiry` with `name`, `email`, optional `service`, and `message`. It returns `201` after Airtable accepts the record.

Set these values in the Supabase project’s [Edge Function secrets](https://supabase.com/docs/guides/functions/secrets):

- `AIRTABLE_TOKEN` is a personal access token with `data.records:write` scoped to the enquiry base.
- `AIRTABLE_BASE_ID` is the enquiry base ID.
- `AIRTABLE_TABLE_ID` is the enquiry table ID.
- `INQUIRY_ALLOWED_ORIGINS` is an optional, comma-separated list of exact website origins for direct browser requests. Requests from a server can omit the Origin header.

The Airtable table needs the fields `Name`, `Email`, `Service`, and `Message`. Use single-line text for Name and Service, Email for Email, and long text for Message.

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

Use the administrator’s email in the query. Remove their row from `portfolio_admins` to revoke workspace access.

3. In [Edge Function secrets](https://supabase.com/docs/guides/functions/secrets), set `FRONTEND_GITHUB_TOKEN` to a GitHub fine-grained token restricted to `Ibkiko26/triecoteq-frontend` with **Contents: Read and write**.
4. Deploy the `publish-portfolio` Edge Function.

```sh
supabase functions deploy publish-portfolio --project-ref <project-ref>
```

The function verifies the signed-in user’s admin membership before using the GitHub token. The token belongs in Supabase secrets. The admin site only needs the publishable key.

### Edit and publish projects

Use **New project** to enter a title, project ID, category, location, year, description and optional price label. Save a draft with a private JPEG, PNG or WebP cover up to 5 MB. To edit a project already on the public site, open **Website portfolio** and select **Edit**.

**Publish to website** saves the draft and commits the selected project and cover to the frontend repository’s `main` branch. The commit preserves the other portfolio entries and site files. The dashboard links to the commit after it is accepted. Visitors see the change after the frontend deployment finishes.

Publish projects from this workspace so the GitHub-backed portfolio file stays current. The existing enquiry Edge Function uses its own Airtable settings.
