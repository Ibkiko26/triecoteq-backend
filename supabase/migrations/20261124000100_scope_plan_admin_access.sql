-- Preserve plans access for existing Studio Admin members.
alter table public.portfolio_admins
  add column can_manage_plans boolean not null default true;
alter table public.portfolio_admins
  alter column can_manage_plans set default false;

create function public.can_manage_plans()
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.portfolio_admins as membership
    where membership.user_id = (select auth.uid()) and membership.can_manage_plans
  );
$$;

revoke all on function public.can_manage_plans() from public, anon, authenticated;
grant execute on function public.can_manage_plans() to authenticated;

alter policy "Admins can read plans" on public.plan_drafts
  using ((select public.can_manage_plans()));
alter policy "Admins can add plans" on public.plan_drafts
  with check ((select public.can_manage_plans()));
alter policy "Admins can edit plans" on public.plan_drafts
  using ((select public.can_manage_plans()))
  with check ((select public.can_manage_plans()));

alter policy "Admins can read private plan files" on storage.objects
  using (bucket_id = 'private-plan-files' and (select public.can_manage_plans()));
alter policy "Admins can upload private plan files" on storage.objects
  with check (
    bucket_id = 'private-plan-files' and (select public.can_manage_plans())
    and name ~ '^[a-f0-9-]{36}/(renders/[a-f0-9-]{36}\.(jpg|png|webp)|(demo|drawings)/[a-f0-9-]{36}\.pdf)$'
  );

alter policy "Admins can read download grant status" on public.plan_download_grants
  using ((select public.can_manage_plans()));
