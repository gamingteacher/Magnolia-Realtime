-- Magnolia Sync schema (Supabase / Postgres). Idempotent: safe to re-run.
-- Run once in the Supabase SQL editor. Never put the service_role key in Magnolia.

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists project_members (
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('owner','editor','viewer')),
  display_name text,
  primary key (project_id, user_id)
);

create table if not exists project_invites (
  code text primary key,
  project_id uuid not null references projects(id) on delete cascade,
  role text not null check (role in ('editor','viewer')),
  expires_at timestamptz not null,
  used_by uuid
);

create table if not exists entities (
  project_id uuid not null references projects(id) on delete cascade,
  kind text not null,
  guid text not null,
  parent_guid text,
  data jsonb not null default '{}'::jsonb,
  version int not null default 1,
  deleted boolean not null default false,
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  seq bigint generated always as identity,
  primary key (project_id, kind, guid)
);
create index if not exists entities_project_seq on entities (project_id, seq);

create table if not exists ops (
  id uuid primary key,
  project_id uuid not null references projects(id) on delete cascade,
  seq bigint generated always as identity,
  kind text not null,
  guid text not null,
  op text not null,
  patch jsonb,
  base_version int not null,
  author uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists ops_project_seq on ops (project_id, seq);

create or replace function is_member(p uuid, roles text[] default array['owner','editor','viewer'])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from project_members
    where project_id = p and user_id = auth.uid() and role = any(roles));
$$;

-- Compare-and-swap write. Returns {ok:true,version,seq} or {ok:false,current:<row>}.
create or replace function upsert_entity(
  p_project uuid, p_kind text, p_guid text, p_parent text, p_data jsonb,
  p_base_version int, p_op_id uuid, p_deleted boolean default false
) returns jsonb language plpgsql security invoker set search_path = public as $$
declare cur entities; new_version int; new_seq bigint;
begin
  if exists (select 1 from ops where id = p_op_id) then
    select * into cur from entities where project_id = p_project and kind = p_kind and guid = p_guid;
    return jsonb_build_object('ok', true, 'version', cur.version, 'seq', cur.seq, 'duplicate', true);
  end if;
  select * into cur from entities
    where project_id = p_project and kind = p_kind and guid = p_guid for update;
  if not found then
    if p_base_version <> 0 then
      return jsonb_build_object('ok', false, 'current', null);
    end if;
    insert into entities (project_id, kind, guid, parent_guid, data, version, deleted)
      values (p_project, p_kind, p_guid, p_parent, p_data, 1, p_deleted)
      returning version, seq into new_version, new_seq;
  else
    if cur.version <> p_base_version then
      return jsonb_build_object('ok', false, 'current', to_jsonb(cur));
    end if;
    update entities set parent_guid = p_parent, data = p_data, deleted = p_deleted,
      version = cur.version + 1, updated_by = auth.uid(), updated_at = now(),
      seq = default
      where project_id = p_project and kind = p_kind and guid = p_guid
      returning version, seq into new_version, new_seq;
  end if;
  insert into ops (id, project_id, kind, guid, op, patch, base_version)
    values (p_op_id, p_project, p_kind, p_guid,
            case when p_deleted then 'delete' else 'upsert' end, p_data, p_base_version);
  return jsonb_build_object('ok', true, 'version', new_version, 'seq', new_seq);
end $$;

create or replace function create_project(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare pid uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into projects (name, owner) values (p_name, auth.uid()) returning id into pid;
  insert into project_members (project_id, user_id, role) values (pid, auth.uid(), 'owner');
  return pid;
end $$;

create or replace function create_invite(p_project uuid, p_role text) returns text
language plpgsql security definer set search_path = public as $$
declare c text := replace(gen_random_uuid()::text, '-', '');
begin
  if not is_member(p_project, array['owner']) then raise exception 'forbidden'; end if;
  insert into project_invites (code, project_id, role, expires_at)
    values (c, p_project, p_role, now() + interval '7 days');
  return c;
end $$;

create or replace function join_project(p_code text, p_display_name text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare inv project_invites;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select * into inv from project_invites
    where code = p_code and used_by is null and expires_at > now() for update;
  if not found then raise exception 'invalid or expired invite'; end if;
  update project_invites set used_by = auth.uid() where code = p_code;
  insert into project_members (project_id, user_id, role, display_name)
    values (inv.project_id, auth.uid(), inv.role, p_display_name)
    on conflict (project_id, user_id) do nothing;
  return inv.project_id;
end $$;

alter table projects enable row level security;
alter table project_members enable row level security;
alter table project_invites enable row level security;
alter table entities enable row level security;
alter table ops enable row level security;

drop policy if exists projects_select on projects;
create policy projects_select on projects for select using (is_member(id));
drop policy if exists members_select on project_members;
create policy members_select on project_members for select using (is_member(project_id));
drop policy if exists members_self_update on project_members;
create policy members_self_update on project_members for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists invites_owner on project_invites;
create policy invites_owner on project_invites for select using (is_member(project_id, array['owner']));
drop policy if exists entities_select on entities;
create policy entities_select on entities for select using (is_member(project_id));
drop policy if exists entities_insert on entities;
create policy entities_insert on entities for insert with check (is_member(project_id, array['owner','editor']));
drop policy if exists entities_update on entities;
create policy entities_update on entities for update
  using (is_member(project_id, array['owner','editor']))
  with check (is_member(project_id, array['owner','editor']));
drop policy if exists ops_select on ops;
create policy ops_select on ops for select using (is_member(project_id));
drop policy if exists ops_insert on ops;
create policy ops_insert on ops for insert with check (is_member(project_id, array['owner','editor']));

insert into storage.buckets (id, name, public) values ('sources', 'sources', false)
  on conflict (id) do nothing;
drop policy if exists sources_rw on storage.objects;
create policy sources_rw on storage.objects for all
  using (bucket_id = 'sources' and is_member(((storage.foldername(name))[1])::uuid))
  with check (bucket_id = 'sources' and is_member(((storage.foldername(name))[1])::uuid,
              array['owner','editor']));

do $$ begin
  alter publication supabase_realtime add table entities;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table project_members;
exception when duplicate_object then null; end $$;
