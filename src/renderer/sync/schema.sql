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

create table if not exists profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_.-]{3,32}$'),
  display_name text not null check (length(display_name) between 1 and 80),
  created_at timestamptz not null default now()
);

create table if not exists project_invites (
  code text primary key,
  project_id uuid not null references projects(id) on delete cascade,
  role text not null check (role in ('editor','viewer')),
  expires_at timestamptz not null,
  used_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  revoked boolean not null default false,
  max_uses int check (max_uses is null or max_uses > 0)
);
alter table project_invites add column if not exists created_at timestamptz not null default now();
alter table project_invites add column if not exists created_by uuid references auth.users(id);
alter table project_invites add column if not exists revoked boolean not null default false;
alter table project_invites add column if not exists max_uses int;

create table if not exists project_invite_uses (
  code text not null references project_invites(code) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (code, user_id)
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

-- Link everything that references a user to profiles (rows from the old anonymous
-- schema have no profile and can never sign in again, so they are cleaned up first).
delete from project_members where user_id not in (select user_id from profiles);
delete from project_invite_uses where user_id not in (select user_id from profiles);
update project_invites set created_by = null where created_by is not null and created_by not in (select user_id from profiles);
update project_invites set used_by = null where used_by is not null and used_by not in (select user_id from profiles);
update entities set updated_by = null where updated_by is not null and updated_by not in (select user_id from profiles);
update ops set author = null where author is not null and author not in (select user_id from profiles);

do $$ begin
  alter table project_members add constraint project_members_user_fkey
    foreign key (user_id) references profiles(user_id) on delete cascade;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table project_invites add constraint project_invites_created_by_profile_fkey
    foreign key (created_by) references profiles(user_id) on delete set null;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table project_invites add constraint project_invites_used_by_profile_fkey
    foreign key (used_by) references profiles(user_id) on delete set null;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table project_invite_uses add constraint project_invite_uses_profile_fkey
    foreign key (user_id) references profiles(user_id) on delete cascade;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table entities add constraint entities_updated_by_profile_fkey
    foreign key (updated_by) references profiles(user_id) on delete set null;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table ops add constraint ops_author_profile_fkey
    foreign key (author) references profiles(user_id) on delete set null;
exception when duplicate_object then null; end $$;
create index if not exists project_members_user on project_members (user_id);

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
declare pid uuid; member_name text;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select display_name into member_name from profiles where user_id = auth.uid();
  insert into projects (name, owner) values (p_name, auth.uid()) returning id into pid;
  insert into project_members (project_id, user_id, role, display_name)
    values (pid, auth.uid(), 'owner', member_name);
  return pid;
end $$;

drop function if exists create_invite(uuid, text);
drop function if exists join_project(text, text);

create or replace function register_profile(p_username text, p_display_name text)
returns profiles language plpgsql security definer set search_path = public as $$
declare result profiles; normalized_username text := lower(trim(p_username));
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if normalized_username !~ '^[a-z0-9_.-]{3,32}$' then
    raise exception 'Username must be 3–32 characters: lowercase letters, numbers, dot, underscore, or hyphen';
  end if;
  if length(trim(p_display_name)) not between 1 and 80 then
    raise exception 'Display name must be between 1 and 80 characters';
  end if;
  insert into profiles (user_id, username, display_name)
    values (auth.uid(), normalized_username, trim(p_display_name))
    on conflict (user_id) do update set display_name = excluded.display_name
    returning * into result;
  update project_members set display_name = result.display_name where user_id = auth.uid();
  return result;
exception when unique_violation then
  raise exception 'Username already taken';
end $$;

create or replace function update_display_name(p_display_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if length(trim(p_display_name)) not between 1 and 80 then
    raise exception 'Display name must be between 1 and 80 characters';
  end if;
  update profiles set display_name = trim(p_display_name) where user_id = auth.uid();
  if not found then raise exception 'Profile not found'; end if;
  update project_members set display_name = trim(p_display_name) where user_id = auth.uid();
end $$;

create or replace function create_invite(
  p_project uuid, p_role text, p_expires_at timestamptz, p_max_uses int default null
) returns text
language plpgsql security definer set search_path = public as $$
declare c text := replace(gen_random_uuid()::text, '-', '');
begin
  if not is_member(p_project, array['owner']) then raise exception 'forbidden'; end if;
  if p_role not in ('editor', 'viewer') then raise exception 'invalid invite role'; end if;
  if p_expires_at <= now() or p_expires_at > now() + interval '90 days' then
    raise exception 'Invite expiry must be within the next 90 days';
  end if;
  if p_max_uses is not null and p_max_uses < 1 then raise exception 'Maximum uses must be positive'; end if;
  insert into project_invites (code, project_id, role, expires_at, created_by, max_uses)
    values (c, p_project, p_role, p_expires_at, auth.uid(), p_max_uses);
  return c;
end $$;

create or replace function revoke_invite(p_code text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update project_invites set revoked = true
    where code = p_code and is_member(project_id, array['owner']);
  if not found then raise exception 'Invite not found or forbidden'; end if;
end $$;

create or replace function list_invites(p_project uuid)
returns table(code text, role text, created_at timestamptz, expires_at timestamptz,
              uses bigint, revoked boolean, max_uses int)
language plpgsql security definer set search_path = public as $$
begin
  if not is_member(p_project, array['owner']) then raise exception 'forbidden'; end if;
  return query
    select i.code, i.role, i.created_at, i.expires_at,
      (select count(*) from project_invite_uses u where u.code = i.code),
      i.revoked, i.max_uses
    from project_invites i where i.project_id = p_project order by i.created_at desc;
end $$;

create or replace function join_project(p_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare inv project_invites; member_name text;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select * into inv from project_invites
    where code = p_code for update;
  if not found then raise exception 'invalid or expired invite'; end if;
  if exists (select 1 from project_members where project_id = inv.project_id and user_id = auth.uid()) then
    return inv.project_id;
  end if;
  if inv.revoked or inv.expires_at <= now() then raise exception 'invalid or expired invite'; end if;
  if inv.max_uses is not null and
     (select count(*) from project_invite_uses where code = p_code) >= inv.max_uses then
    raise exception 'invite has reached its maximum number of uses';
  end if;
  select display_name into member_name from profiles where user_id = auth.uid();
  if member_name is null then raise exception 'Create an account profile before joining a project'; end if;
  insert into project_members (project_id, user_id, role, display_name)
    values (inv.project_id, auth.uid(), inv.role, member_name)
    on conflict (project_id, user_id) do nothing;
  insert into project_invite_uses (code, user_id) values (p_code, auth.uid())
    on conflict (code, user_id) do nothing;
  return inv.project_id;
end $$;

create or replace function list_my_projects()
returns table(id uuid, name text, role text)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, m.role from project_members m
  join projects p on p.id = m.project_id where m.user_id = auth.uid()
  order by p.name;
$$;

create or replace function list_members(p_project uuid)
returns table(user_id uuid, username text, display_name text, role text)
language plpgsql security definer set search_path = public as $$
begin
  if not is_member(p_project, array['owner']) then raise exception 'forbidden'; end if;
  return query
    select m.user_id, p.username, coalesce(p.display_name, m.display_name), m.role
    from project_members m left join profiles p on p.user_id = m.user_id
    where m.project_id = p_project order by m.role, p.username;
end $$;

create or replace function set_member_role(p_project uuid, p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_member(p_project, array['owner']) then raise exception 'forbidden'; end if;
  if p_role not in ('editor', 'viewer') then raise exception 'Role must be editor or viewer'; end if;
  update project_members set role = p_role
    where project_id = p_project and user_id = p_user and role <> 'owner';
  if not found then raise exception 'Member not found or is an owner'; end if;
end $$;

create or replace function remove_member(p_project uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare target_role text;
begin
  if not is_member(p_project, array['owner']) then raise exception 'forbidden'; end if;
  select role into target_role from project_members where project_id = p_project and user_id = p_user;
  if not found then raise exception 'Member not found'; end if;
  if target_role = 'owner' and
    (select count(*) from project_members where project_id = p_project and role = 'owner') <= 1 then
    raise exception 'Cannot remove the last owner';
  end if;
  delete from project_members where project_id = p_project and user_id = p_user;
end $$;

create or replace view ops_with_author with (security_invoker = true) as
  select o.id, o.project_id, o.seq, o.kind, o.guid, o.op, o.patch, o.base_version,
         o.author, o.created_at, coalesce(p.display_name, p.username) as author_name
  from ops o left join profiles p on p.user_id = o.author;

alter table projects enable row level security;
alter table project_members enable row level security;
alter table project_invites enable row level security;
alter table profiles enable row level security;
alter table project_invite_uses enable row level security;
alter table entities enable row level security;
alter table ops enable row level security;

drop policy if exists projects_select on projects;
create policy projects_select on projects for select using (is_member(id));
drop policy if exists members_select on project_members;
create policy members_select on project_members for select using (is_member(project_id));
drop policy if exists members_self_update on project_members;
drop policy if exists profiles_read on profiles;
create policy profiles_read on profiles for select using (
  user_id = auth.uid() or exists (
    select 1 from project_members mine
    join project_members theirs on theirs.project_id = mine.project_id
    where mine.user_id = auth.uid() and theirs.user_id = profiles.user_id
  )
);
drop policy if exists invite_uses_owner_read on project_invite_uses;
create policy invite_uses_owner_read on project_invite_uses for select using (
  exists (select 1 from project_invites i where i.code = project_invite_uses.code
          and is_member(i.project_id, array['owner']))
);
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
