alter table public.portfolio_drafts
  add column deletion_state text not null default 'active' check (deletion_state in ('active', 'deleting', 'deleted')),
  add column publish_lock_until timestamptz,
  drop constraint portfolio_drafts_project_id_key;

alter table public.plan_drafts
  add column deletion_state text not null default 'active' check (deletion_state in ('active', 'deleting', 'deleted')),
  add column publish_lock_until timestamptz,
  drop constraint plan_drafts_plan_id_key;

create unique index portfolio_drafts_available_project_id_key
  on public.portfolio_drafts (project_id) where deletion_state <> 'deleted';
create unique index plan_drafts_available_plan_id_key
  on public.plan_drafts (plan_id) where deletion_state <> 'deleted';

alter policy "Portfolio admins can read drafts" on public.portfolio_drafts
  using (deletion_state <> 'deleted' and (select public.is_portfolio_admin()));
alter policy "Portfolio admins can edit drafts" on public.portfolio_drafts
  using (deletion_state = 'active' and (select public.is_portfolio_admin()))
  with check (deletion_state = 'active' and (select public.is_portfolio_admin()));

alter policy "Admins can read plans" on public.plan_drafts
  using (deletion_state <> 'deleted' and (select public.can_manage_plans()));
alter policy "Admins can edit plans" on public.plan_drafts
  using (deletion_state = 'active' and (select public.can_manage_plans()))
  with check (deletion_state = 'active' and (select public.can_manage_plans()));
