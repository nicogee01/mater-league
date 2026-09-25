-- =========================================================
-- Mater League: power rankings storage (Supabase / Postgres)
-- Run once in the Supabase SQL Editor. Safe to re-run.
--
-- Privacy model:
--   * No table is readable or writable from the website directly.
--   * The site can only call the functions at the bottom:
--       check_code, submit_ballot, get_my_ballot, get_results, get_rounds
--   * Club codes are stored as salted SHA-256 hashes, never in plain text.
--   * Results are anonymous (averages, best/worst vote, notes without names).
--     When they're revealed is set by pr-reveal.sql (run it after this file).
--
-- The eight club logins (pr_voters rows) are NOT in this file. They live in
-- private/paste-into-supabase.sql, which is kept out of git.
-- =========================================================

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.pr_voters (
  manager   text primary key,          -- Sleeper username, lowercase
  salt      text not null,
  code_hash text not null              -- sha256(salt || CODE), hex
);

create table if not exists public.pr_ballots (
  week         int  not null check (week between 1 and 60),
  voter        text not null references public.pr_voters (manager),
  rankings     text[] not null,        -- the other clubs' managers, best first
  notes        jsonb not null default '{}'::jsonb,  -- { manager: "note" }
  submitted_at timestamptz not null default now(),
  primary key (week, voter)            -- one ballot per club per round
);

create table if not exists public.pr_failed_codes (
  manager text not null,
  at      timestamptz not null default now()
);

alter table public.pr_voters       enable row level security;
alter table public.pr_ballots      enable row level security;
alter table public.pr_failed_codes enable row level security;
revoke all on public.pr_voters, public.pr_ballots, public.pr_failed_codes from anon, authenticated;

-- ---------------------------------------------------------
-- internal: check a club's code (10 wrong tries per hour, then locked)
-- returns { ok, manager } or { ok: false, error }
-- ---------------------------------------------------------
create or replace function public.pr_verify(p_voter text, p_code text)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v     public.pr_voters;
  fails int;
  clean text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
begin
  select * into v from public.pr_voters where manager = lower(trim(p_voter));
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Unknown club.');
  end if;
  select count(*) into fails from public.pr_failed_codes
   where manager = v.manager and at > now() - interval '1 hour';
  if fails >= 10 then
    return jsonb_build_object('ok', false, 'error', 'Too many wrong codes. Try again in an hour.');
  end if;
  if encode(digest(v.salt || clean, 'sha256'), 'hex') <> v.code_hash then
    insert into public.pr_failed_codes (manager) values (v.manager);
    return jsonb_build_object('ok', false, 'error', 'That code doesn''t match this club.');
  end if;
  return jsonb_build_object('ok', true, 'manager', v.manager);
end $$;

-- ---------------------------------------------------------
-- public: is this the right code for this club?
-- ---------------------------------------------------------
create or replace function public.check_code(p_voter text, p_code text)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
begin
  return public.pr_verify(p_voter, p_code) - 'manager';
end $$;

-- ---------------------------------------------------------
-- public: submit (or replace) this club's ballot for a round
-- p_rankings: every OTHER club's manager, best first
-- p_notes:    optional { manager: "note" }, 280 characters max each
-- ---------------------------------------------------------
create or replace function public.submit_ballot(p_week int, p_voter text, p_code text, p_rankings text[], p_notes jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  auth     jsonb := public.pr_verify(p_voter, p_code);
  me       text;
  expected text[];
  ranked   text[];
  clean    jsonb;
begin
  if not (auth ->> 'ok')::boolean then return auth; end if;
  me := auth ->> 'manager';
  if p_week is null or p_week < 1 or p_week > 60 then
    return jsonb_build_object('ok', false, 'error', 'Unknown round.');
  end if;

  select array_agg(manager order by manager) into expected from public.pr_voters where manager <> me;
  select array_agg(lower(trim(x))) into ranked from unnest(p_rankings) as x;
  if ranked is null
     or cardinality(ranked) <> cardinality(expected)
     or (select count(distinct x) from unnest(ranked) as x) <> cardinality(expected)
     or not (ranked @> expected and expected @> ranked) then
    return jsonb_build_object('ok', false, 'error', 'Rank every other club exactly once (not your own).');
  end if;

  select coalesce(jsonb_object_agg(lower(key), left(btrim(value), 280)), '{}'::jsonb) into clean
    from jsonb_each_text(coalesce(p_notes, '{}'::jsonb))
   where lower(key) = any (expected) and btrim(value) <> '';

  insert into public.pr_ballots (week, voter, rankings, notes, submitted_at)
  values (p_week, me, ranked, clean, now())
  on conflict (week, voter) do update
    set rankings = excluded.rankings, notes = excluded.notes, submitted_at = now();

  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------
-- public: a club can read back its OWN ballot (to edit it)
-- ---------------------------------------------------------
create or replace function public.get_my_ballot(p_week int, p_voter text, p_code text)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  auth jsonb := public.pr_verify(p_voter, p_code);
  b    public.pr_ballots;
begin
  if not (auth ->> 'ok')::boolean then return auth; end if;
  select * into b from public.pr_ballots where week = p_week and voter = auth ->> 'manager';
  if not found then return jsonb_build_object('ok', true, 'ballot', null); end if;
  return jsonb_build_object('ok', true, 'ballot',
    jsonb_build_object('rankings', to_jsonb(b.rankings), 'notes', b.notes, 'submitted_at', b.submitted_at));
end $$;

-- ---------------------------------------------------------
-- public: anonymous results for a round (hidden until 3+ ballots)
-- ---------------------------------------------------------
create or replace function public.get_results(p_week int)
returns jsonb
language sql security definer stable
set search_path = public, extensions
as $$
  with b as (
    select * from public.pr_ballots where week = p_week
  ),
  pos as (
    select b.voter, r.manager, r.ord
      from b, unnest(b.rankings) with ordinality as r(manager, ord)
  ),
  agg as (
    select manager, count(*) as votes, round(avg(ord), 2) as avg_rank, min(ord) as best, max(ord) as worst
      from pos group by manager
  ),
  nts as (  -- notes, shuffled so their order says nothing about who wrote them
    select lower(n.key) as manager, jsonb_agg(n.value order by md5(b.voter || n.key || p_week::text)) as notes
      from b, jsonb_each_text(b.notes) as n
     group by lower(n.key)
  )
  select jsonb_build_object(
    'week', p_week,
    'ballots', (select count(*) from b),
    'min_ballots', 3,
    'teams', case when (select count(*) from b) < 3 then '[]'::jsonb else (
      select coalesce(jsonb_agg(jsonb_build_object(
               'manager', agg.manager, 'votes', agg.votes, 'avg', agg.avg_rank,
               'best', agg.best, 'worst', agg.worst, 'notes', coalesce(nts.notes, '[]'::jsonb))
             order by agg.avg_rank, agg.votes desc), '[]'::jsonb)
        from agg left join nts using (manager)
    ) end
  );
$$;

-- ---------------------------------------------------------
-- public: which rounds have ballots (for the archive)
-- ---------------------------------------------------------
create or replace function public.get_rounds()
returns jsonb
language sql security definer stable
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(jsonb_build_object('week', week, 'ballots', n) order by week desc), '[]'::jsonb)
    from (select week, count(*) as n from public.pr_ballots group by week) s;
$$;

-- only the public functions are callable from the website
revoke execute on function public.pr_verify(text, text) from public, anon, authenticated;
revoke execute on function public.check_code(text, text), public.submit_ballot(int, text, text, text[], jsonb),
  public.get_my_ballot(int, text, text), public.get_results(int), public.get_rounds() from public;
grant execute on function public.check_code(text, text), public.submit_ballot(int, text, text, text[], jsonb),
  public.get_my_ballot(int, text, text), public.get_results(int), public.get_rounds() to anon, authenticated;
