create table public.portfolio_admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

alter table public.portfolio_admins enable row level security;
revoke all on public.portfolio_admins from anon, authenticated;
grant select on public.portfolio_admins to authenticated;

create policy "Members can read their own portfolio access"
  on public.portfolio_admins for select to authenticated
  using (user_id = (select auth.uid()));

create function public.is_portfolio_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.portfolio_admins
    where user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_portfolio_admin() from public, anon, authenticated;
grant execute on function public.is_portfolio_admin() to authenticated;

create table public.portfolio_drafts (
  id uuid primary key default gen_random_uuid(),
  project_id text not null unique check (
    char_length(project_id) <= 80 and project_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  title text not null check (char_length(btrim(title)) between 1 and 150),
  category text not null check (char_length(btrim(category)) between 1 and 70),
  location text not null check (char_length(btrim(location)) between 1 and 150),
  year text not null check (year ~ '^[12][0-9]{3}$'),
  description text not null check (char_length(btrim(description)) between 1 and 3000),
  price_label text not null default '' check (char_length(price_label) <= 100),
  cover_path text check (cover_path is null or (
    split_part(cover_path, '/', 1) = id::text
    and cover_path ~ '^[a-f0-9-]{36}/[a-f0-9-]{36}\.(jpg|png|webp)$'
  )),
  source_image text check (source_image is null or (
    source_image ~* '^(admin/portfolio-library|assets/(portfolio|hero))/[a-z0-9_ .-]+\.(jpe?g|png|webp)$'
    and position('..' in source_image) = 0
  )),
  revision integer not null default 1,
  published_revision integer check (published_revision between 1 and revision),
  published_commit text check (published_commit ~ '^[a-f0-9]{40}$'),
  updated_at timestamptz not null default now()
);

alter table public.portfolio_drafts enable row level security;
revoke all on public.portfolio_drafts from anon, authenticated;
grant select on public.portfolio_drafts to authenticated;
grant insert (id, project_id, title, category, location, year, description, price_label, cover_path, source_image)
  on public.portfolio_drafts to authenticated;
grant update (project_id, title, category, location, year, description, price_label, cover_path)
  on public.portfolio_drafts to authenticated;
grant select, update on public.portfolio_drafts to service_role;

create policy "Portfolio admins can read drafts"
  on public.portfolio_drafts for select to authenticated
  using ((select public.is_portfolio_admin()));
create policy "Portfolio admins can add drafts"
  on public.portfolio_drafts for insert to authenticated
  with check ((select public.is_portfolio_admin()));
create policy "Portfolio admins can edit drafts"
  on public.portfolio_drafts for update to authenticated
  using ((select public.is_portfolio_admin()))
  with check ((select public.is_portfolio_admin()));

create function public.revise_portfolio_draft()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (old.published_revision is not null or old.source_image is not null)
    and new.project_id is distinct from old.project_id then
    raise exception 'A published or imported project ID cannot be changed';
  end if;

  if row(new.project_id, new.title, new.category, new.location, new.year, new.description, new.price_label, new.cover_path)
    is distinct from
    row(old.project_id, old.title, old.category, old.location, old.year, old.description, old.price_label, old.cover_path) then
    new.revision := old.revision + 1;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create trigger revise_portfolio_draft
  before update on public.portfolio_drafts
  for each row execute function public.revise_portfolio_draft();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('portfolio-draft-covers', 'portfolio-draft-covers', false, 5242880, array['image/jpeg', 'image/png', 'image/webp']);

create policy "Portfolio admins can read private covers"
  on storage.objects for select to authenticated
  using (bucket_id = 'portfolio-draft-covers' and (select public.is_portfolio_admin()));
create policy "Portfolio admins can upload private covers"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'portfolio-draft-covers'
    and (select public.is_portfolio_admin())
    and name ~ '^[a-f0-9-]{36}/[a-f0-9-]{36}\.(jpg|png|webp)$'
  );
create policy "Portfolio admins can clean up unused covers"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'portfolio-draft-covers'
    and (select public.is_portfolio_admin())
    and not exists (select 1 from public.portfolio_drafts where cover_path = storage.objects.name)
  );
