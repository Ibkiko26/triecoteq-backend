create table public.plan_drafts (
  id uuid primary key default gen_random_uuid(),
  plan_id text not null unique check (char_length(plan_id) <= 80 and plan_id ~* '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title text not null check (length(btrim(title)) between 1 and 150),
  description text not null check (length(btrim(description)) between 1 and 3000),
  current_price integer not null check (current_price between 0 and 1000000),
  old_price integer check (old_price > current_price and old_price <= 1000000),
  offer boolean not null default false,
  original_id text,
  original_images text[] not null default '{}',
  original_demo text,
  render_paths text[] not null default '{}' check (cardinality(render_paths) <= 6),
  demo_path text,
  drawing_path text,
  revision integer not null default 1,
  published_revision integer check (published_revision between 1 and revision),
  published_commit text check (published_commit ~ '^[a-f0-9]{40}$'),
  published_drawing_path text,
  updated_at timestamptz not null default now(),
  check ((offer and current_price = 0 and old_price is null) or (not offer and current_price > 0)),
  check (original_id is null or original_id = plan_id)
);

alter table public.plan_drafts enable row level security;
revoke all on public.plan_drafts from anon, authenticated;
grant select on public.plan_drafts to authenticated;
grant insert (id, plan_id, title, description, current_price, old_price, offer, original_id, original_images, original_demo, render_paths, demo_path, drawing_path)
  on public.plan_drafts to authenticated;
grant update (plan_id, title, description, current_price, old_price, offer, render_paths, demo_path, drawing_path)
  on public.plan_drafts to authenticated;
grant select, update on public.plan_drafts to service_role;

create policy "Admins can read plans" on public.plan_drafts for select to authenticated
  using ((select public.is_portfolio_admin()));
create policy "Admins can add plans" on public.plan_drafts for insert to authenticated
  with check ((select public.is_portfolio_admin()));
create policy "Admins can edit plans" on public.plan_drafts for update to authenticated
  using ((select public.is_portfolio_admin())) with check ((select public.is_portfolio_admin()));

create function public.revise_plan_draft()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (old.published_revision is not null or old.original_id is not null)
    and new.plan_id is distinct from old.plan_id then
    raise exception 'The ID of a published or imported plan cannot be changed';
  end if;
  if row(new.plan_id, new.title, new.description, new.current_price, new.old_price, new.offer, new.render_paths, new.demo_path, new.drawing_path)
    is distinct from row(old.plan_id, old.title, old.description, old.current_price, old.old_price, old.offer, old.render_paths, old.demo_path, old.drawing_path) then
    new.revision := old.revision + 1;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create trigger revise_plan_draft before update on public.plan_drafts
  for each row execute function public.revise_plan_draft();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('private-plan-files', 'private-plan-files', false, 26214400,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

create policy "Admins can read private plan files" on storage.objects for select to authenticated
  using (bucket_id = 'private-plan-files' and (select public.is_portfolio_admin()));
create policy "Admins can upload private plan files" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'private-plan-files' and (select public.is_portfolio_admin())
    and name ~ '^[a-f0-9-]{36}/(renders/[a-f0-9-]{36}\.(jpg|png|webp)|(demo|drawings)/[a-f0-9-]{36}\.pdf)$'
  );

create table public.plan_download_grants (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references public.plan_drafts(id),
  plan_id text not null,
  drawing_path text not null,
  order_reference text not null check (length(btrim(order_reference)) between 1 and 100),
  buyer_email text not null check (length(buyer_email) <= 254),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index plan_download_grants_draft_idx on public.plan_download_grants (draft_id, created_at desc);

alter table public.plan_download_grants enable row level security;
revoke all on public.plan_download_grants from anon, authenticated;
grant select (id, draft_id, order_reference, buyer_email, expires_at, revoked_at, created_at)
  on public.plan_download_grants to authenticated;
grant select, insert, update on public.plan_download_grants to service_role;
create policy "Admins can read download grant status" on public.plan_download_grants for select to authenticated
  using ((select public.is_portfolio_admin()));
