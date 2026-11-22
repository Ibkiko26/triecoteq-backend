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
