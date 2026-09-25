-- =========================================================
-- Mater League power rankings: reveal + voting window
-- Run in the Supabase SQL Editor after power-rankings.sql. Safe to re-run
-- (e.g. if the Premier League moves a deadline: regenerate and paste again).
--
-- Round N = rankings after gameweek N.
--   * Results are revealed when every club has voted, OR one day before the
--     gameweek N+1 deadline, whichever comes first.
--   * With fewer than 3 ballots nothing is ever shown (it would expose voters).
--   * Voting for a round closes the moment its results are revealed.
-- Deadlines are the official Premier League ones (FPL API, 2026/27 season).
-- =========================================================

create table if not exists public.pr_schedule (
  week     int primary key,
  deadline timestamptz not null
);
alter table public.pr_schedule enable row level security;
revoke all on public.pr_schedule from anon, authenticated;

insert into public.pr_schedule (week, deadline) values
  (1, '2026-08-21T17:30:00Z'),
  (2, '2026-08-28T17:30:00Z'),
  (3, '2026-09-04T17:30:00Z'),
  (4, '2026-09-12T12:30:00Z'),
  (5, '2026-09-18T17:30:00Z'),
  (6, '2026-10-10T10:00:00Z'),
  (7, '2026-10-17T10:00:00Z'),
  (8, '2026-10-23T17:30:00Z'),
  (9, '2026-10-31T11:00:00Z'),
  (10, '2026-11-06T18:30:00Z'),
  (11, '2026-11-21T11:00:00Z'),
  (12, '2026-11-27T18:30:00Z'),
  (13, '2026-12-02T18:30:00Z'),
  (14, '2026-12-05T13:30:00Z'),
  (15, '2026-12-12T13:30:00Z'),
  (16, '2026-12-19T13:30:00Z'),
  (17, '2026-12-26T11:00:00Z'),
  (18, '2026-12-29T18:00:00Z'),
  (19, '2027-01-01T18:30:00Z'),
  (20, '2027-01-05T18:00:00Z'),
  (21, '2027-01-16T13:30:00Z'),
  (22, '2027-01-23T13:30:00Z'),
  (23, '2027-01-30T13:30:00Z'),
  (24, '2027-02-06T13:30:00Z'),
  (25, '2027-02-10T18:30:00Z'),
  (26, '2027-02-20T13:30:00Z'),
  (27, '2027-02-27T13:30:00Z'),
  (28, '2027-03-03T18:30:00Z'),
  (29, '2027-03-13T13:30:00Z'),
  (30, '2027-03-20T13:30:00Z'),
  (31, '2027-04-10T12:30:00Z'),
  (32, '2027-04-17T12:30:00Z'),
  (33, '2027-04-24T12:30:00Z'),
  (34, '2027-05-01T12:30:00Z'),
  (35, '2027-05-08T12:30:00Z'),
  (36, '2027-05-15T12:30:00Z'),
  (37, '2027-05-23T12:30:00Z'),
  (38, '2027-05-30T13:30:00Z')
on conflict (week) do update set deadline = excluded.deadline;

-- internal: where a round stands
create or replace function public.pr_round_state(p_week int)
returns jsonb
language plpgsql security definer stable
set search_path = public, extensions
as $$
declare
  voters    int := (select count(*) from public.pr_voters);
  ballots   int := (select count(*) from public.pr_ballots where week = p_week);
  next_dl   timestamptz := (select deadline from public.pr_schedule where week = p_week + 1);
  this_dl   timestamptz := (select deadline from public.pr_schedule where week = p_week);
  reveal_at timestamptz := coalesce(next_dl - interval '1 day', this_dl + interval '8 days');
  revealed  boolean;
begin
  revealed := ballots >= voters or (reveal_at is not null and now() >= reveal_at and ballots >= 3);
  return jsonb_build_object(
    'ballots', ballots, 'voters', voters, 'min_ballots', 3,
    'reveal_at', reveal_at, 'next_deadline', next_dl,
    'revealed', revealed,
    'closed', revealed or (reveal_at is not null and now() >= reveal_at)
  );
end $$;
revoke execute on function public.pr_round_state(int) from public, anon, authenticated;

-- public: anonymous results, only once the round is revealed
create or replace function public.get_results(p_week int)
returns jsonb
language plpgsql security definer stable
set search_path = public, extensions
as $$
declare
  st    jsonb := public.pr_round_state(p_week);
  teams jsonb := '[]'::jsonb;
begin
  if (st ->> 'revealed')::boolean then
    with b as (select * from public.pr_ballots where week = p_week),
    pos as (select b.voter, r.manager, r.ord from b, unnest(b.rankings) with ordinality as r(manager, ord)),
    agg as (select manager, count(*) as votes, round(avg(ord), 2) as avg_rank, min(ord) as best, max(ord) as worst from pos group by manager),
    nts as (select lower(n.key) as manager, jsonb_agg(n.value order by md5(b.voter || n.key || p_week::text)) as notes
              from b, jsonb_each_text(b.notes) as n group by lower(n.key))
    select coalesce(jsonb_agg(jsonb_build_object(
             'manager', agg.manager, 'votes', agg.votes, 'avg', agg.avg_rank,
             'best', agg.best, 'worst', agg.worst, 'notes', coalesce(nts.notes, '[]'::jsonb))
           order by agg.avg_rank, agg.votes desc), '[]'::jsonb)
      into teams
      from agg left join nts using (manager);
  end if;
  return st || jsonb_build_object('week', p_week, 'teams', teams);
end $$;

-- public: submit/replace a ballot, only while the round is still open
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
  if (public.pr_round_state(p_week) ->> 'closed')::boolean then
    return jsonb_build_object('ok', false, 'error', 'Voting for this round has closed.');
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

grant execute on function public.get_results(int), public.submit_ballot(int, text, text, text[], jsonb) to anon, authenticated;
