alter table public.portfolio_drafts
  add column original_project_id text check (
    original_project_id is null or (char_length(original_project_id) <= 80 and original_project_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
  ),
  add column source_images text[] not null default '{}' check (cardinality(source_images) <= 6),
  add column gallery_paths text[] not null default '{}' check (
    cardinality(gallery_paths) + case when cover_path is null then 0 else 1 end <= 6
  );

update public.portfolio_drafts
set original_project_id = project_id
where source_image is not null or published_revision is not null;

grant insert (original_project_id, source_images, gallery_paths) on public.portfolio_drafts to authenticated;
grant update (gallery_paths) on public.portfolio_drafts to authenticated;

create or replace function public.revise_portfolio_draft()
returns trigger language plpgsql set search_path = '' as $$
begin
  if row(new.project_id, new.title, new.category, new.location, new.year, new.description, new.price_label, new.cover_path, new.gallery_paths)
    is distinct from
    row(old.project_id, old.title, old.category, old.location, old.year, old.description, old.price_label, old.cover_path, old.gallery_paths) then
    new.revision := old.revision + 1;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

alter policy "Portfolio admins can clean up unused covers" on storage.objects
  using (
    bucket_id = 'portfolio-draft-covers'
    and (select public.is_portfolio_admin())
    and not exists (
      select 1 from public.portfolio_drafts
      where cover_path = storage.objects.name or storage.objects.name = any(gallery_paths)
    )
  );

-- Existing private renders previously replaced the original public images.
update public.plan_drafts
set original_images = '{}'
where cardinality(render_paths) > 0 and cardinality(original_images) > 0;

grant update (original_images) on public.plan_drafts to authenticated;

create or replace function public.revise_plan_draft()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (old.published_revision is not null or old.original_id is not null)
    and new.plan_id is distinct from old.plan_id then
    raise exception 'The ID of a published or imported plan cannot be changed';
  end if;
  if row(new.plan_id, new.title, new.description, new.current_price, new.old_price, new.offer, new.original_images, new.render_paths, new.demo_path, new.drawing_path)
    is distinct from
    row(old.plan_id, old.title, old.description, old.current_price, old.old_price, old.offer, old.original_images, old.render_paths, old.demo_path, old.drawing_path) then
    new.revision := old.revision + 1;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create policy "Plan admins can clean up unused renders"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'private-plan-files'
    and (select public.can_manage_plans())
    and name ~ '^[a-f0-9-]{36}/renders/[a-f0-9-]{36}\.(jpg|png|webp)$'
    and not exists (select 1 from public.plan_drafts where storage.objects.name = any(render_paths))
  );
