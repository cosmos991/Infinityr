alter table infinityr_private.progress
  add column job text check (job in ('rps', 'muk'));

-- A fight's deals are reproducible from its saved start time, including during idle catch-up.
create function infinityr_private.hand_duel(job text, save_hash bytea, start_ms bigint)
returns jsonb language plpgsql immutable strict set search_path = ''
as $$
declare
  deal bytea := sha256(save_hash || convert_to(start_ms::text, 'UTF8'));
  left_hand integer;
  right_hand integer;
  attacker integer := 0;
  winner integer := 0;
  rounds jsonb := '[]'::jsonb;
begin
  for i in 0..11 loop
    left_hand := mod(get_byte(deal, 2 * i), 3);
    right_hand := mod(get_byte(deal, 2 * i + 1), 3);
    if left_hand = right_hand then
      winner := attacker;
    else
      attacker := case when mod(left_hand - right_hand + 3, 3) = 1 then 1 else -1 end;
      if job = 'rps' then winner := attacker; end if;
    end if;
    rounds := rounds || jsonb_build_array(jsonb_build_object(
      'luna', left_hand, 'boss', right_hand, 'owner', attacker
    ));
    exit when winner <> 0;
  end loop;
  return jsonb_build_object('rounds', rounds, 'winner', winner,
    'bonus', case when winner = 1 then case when job = 'rps' then 1 else 2 end else 0 end);
end;
$$;

create or replace function public.infinityr_play(save_code text, action text, expected_revision text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  code_hash bytea;
  state infinityr_private.progress%rowtype;
  now_ms bigint;
  elapsed bigint;
  reward numeric := 0;
  attack numeric;
  hero_max numeric;
  hero_hp numeric;
  enemy_hp numeric;
  attack_turns numeric;
  loss_turns numeric;
  fight_turns numeric;
  farm_turns numeric;
  kills numeric;
  play_floor numeric;
  upgrade_cost numeric;
  vitality_cost numeric;
  enemy_max numeric;
  boss_damage numeric;
  result text := 'sync';
  gap_seconds bigint;
  completed integer := 0;
  pending boolean := false;
  duel jsonb;
  skill jsonb;
  bonus numeric;
begin
  if save_code is null or save_code !~ '^[0-9a-f]{64}$'
      or action is null or action not in ('create', 'sync', 'upgrade', 'vitality', 'challenge', 'auto_on', 'auto_off', 'job_rps', 'job_muk') then
    raise sqlstate '22023' using message = 'invalid_input';
  end if;

  code_hash := pg_catalog.sha256(pg_catalog.decode(save_code, 'hex'));
  if action = 'create' then
    insert into infinityr_private.progress (save_hash, settled_ms)
      values (code_hash, floor(extract(epoch from clock_timestamp()) * 1000)::bigint)
      on conflict (save_hash) do nothing;
  end if;

  select * into state from infinityr_private.progress
    where save_hash = code_hash for update;
  if not found then
    raise sqlstate 'P0002' using message = 'save_not_found';
  end if;

  now_ms := greatest(state.settled_ms, floor(extract(epoch from clock_timestamp()) * 1000)::bigint);
  gap_seconds := greatest(0, now_ms - coalesce(state.observed_ms, state.settled_ms)) / 1000;
  attack := 4 * state.sword + 4;
  hero_max := 54 + 6 * state.sword + 15 * state.vitality;
  hero_hp := hero_max;

  loop
    play_floor := state.best + 1;
    enemy_max := 24 + 24 * play_floor;
    boss_damage := 3 + 4 * play_floor;
    attack_turns := ceil(enemy_max / attack);
    loss_turns := ceil(hero_max / boss_damage);

    if state.challenge_started_ms is null then
      exit when not state.auto_boss or attack_turns > loss_turns
        or (state.best >= 10 and state.job is null);
      state.challenge_started_ms := state.settled_ms;
      if result = 'sync' then result := 'challenging'; end if;
    end if;

    elapsed := (now_ms - state.challenge_started_ms) / 1050;
    bonus := 0;
    if state.job is not null and least(attack_turns, loss_turns) >= 5 then
      duel := infinityr_private.hand_duel(state.job, code_hash, state.challenge_started_ms);
      bonus := (duel->>'bonus')::numeric;
      attack_turns := greatest(5, attack_turns - bonus);
      if elapsed between 4 and 5 and not pending then
        skill := duel || jsonb_build_object('id', state.challenge_started_ms::text, 'job', state.job, 'struck', elapsed >= 5);
      end if;
    end if;
    fight_turns := least(attack_turns, loss_turns);
    if elapsed < fight_turns then
      hero_hp := hero_max - elapsed * boss_damage;
      enemy_hp := enemy_max - (elapsed + case when elapsed >= 5 then bonus else 0 end) * attack;
      exit;
    end if;

    -- Keep any remaining elapsed time for the next call after a long catch-up.
    if completed >= 128 then
      pending := true;
      enemy_hp := enemy_max;
      exit;
    end if;
    completed := completed + 1;

    state.settled_ms := state.challenge_started_ms + fight_turns::bigint * 1050;
    state.challenge_started_ms := null;
    if attack_turns <= loss_turns then
      state.best := play_floor;
      state.paid := 0;
      reward := reward + 3 * (2 + div(play_floor - 1, 5));
      result := 'won';
    else
      result := 'lost';
      exit;
    end if;
  end loop;

  if state.challenge_started_ms is null then
    play_floor := state.best + 1;
    enemy_max := 12 + 12 * play_floor;
    enemy_hp := enemy_max;
    attack_turns := ceil(enemy_hp / attack);
    elapsed := (now_ms - state.settled_ms) / 1050;
    farm_turns := elapsed + state.paid;
    kills := div(farm_turns, attack_turns);
    state.paid := mod(farm_turns, attack_turns);
    state.settled_ms := state.settled_ms + elapsed * 1050;
    reward := reward + kills * (2 + div(play_floor - 1, 5));
    enemy_hp := enemy_hp - state.paid * attack;
  end if;

  state.gold := state.gold + reward;
  upgrade_cost := infinityr_private.sword_price(state.sword);

  vitality_cost := infinityr_private.vitality_price(state.vitality);

  if not pending and action in ('upgrade', 'vitality', 'challenge', 'auto_on', 'auto_off', 'job_rps', 'job_muk') then
    if expected_revision is distinct from state.revision::text then
      result := 'stale';
    elsif action in ('auto_on', 'auto_off') then
      state.auto_boss := action = 'auto_on';
      if state.challenge_started_ms is null then state.settled_ms := now_ms; end if;
      state.revision := state.revision + 1;
      result := action;
    elsif state.challenge_started_ms is not null then
      result := 'busy';
    elsif action in ('job_rps', 'job_muk') then
      if state.best >= 10 and state.job is null then
        state.job := case when action = 'job_rps' then 'rps' else 'muk' end;
        if state.auto_boss then state.settled_ms := now_ms; end if;
        state.revision := state.revision + 1;
        result := 'job_chosen';
      end if;
    elsif action = 'upgrade' and state.gold >= upgrade_cost then
      state.gold := state.gold - upgrade_cost;
      state.sword := state.sword + 1;
      upgrade_cost := infinityr_private.sword_price(state.sword);
      state.paid := 0;
      state.revision := state.revision + 1;
      enemy_hp := enemy_max;
      hero_max := hero_max + 6;
      hero_hp := hero_max;
      if state.auto_boss then state.settled_ms := now_ms; end if;
      result := 'upgraded';
    elsif action = 'vitality' and state.gold >= vitality_cost then
      state.gold := state.gold - vitality_cost;
      state.vitality := state.vitality + 1;
      state.revision := state.revision + 1;
      hero_max := hero_max + 15;
      hero_hp := hero_max;
      vitality_cost := infinityr_private.vitality_price(state.vitality);
      if state.auto_boss then state.settled_ms := now_ms; end if;
      result := 'vitality_upgraded';
    elsif action = 'challenge' then
      state.challenge_started_ms := now_ms;
      state.revision := state.revision + 1;
      enemy_max := 24 + 24 * play_floor;
      enemy_hp := enemy_max;
      result := 'challenging';
    end if;
  end if;

  update infinityr_private.progress set
    gold = state.gold, sword = state.sword, vitality = state.vitality, best = state.best, paid = state.paid,
    settled_ms = state.settled_ms, challenge_started_ms = state.challenge_started_ms,
    revision = state.revision, auto_boss = state.auto_boss, observed_ms = now_ms, job = state.job
  where save_hash = code_hash;

  return jsonb_build_object(
    'gold', state.gold::text, 'level', state.sword::text, 'best', state.best::text,
    'floor', play_floor::text, 'hp', enemy_hp::text, 'maxEnemy', enemy_max::text, 'hero', hero_hp::text,
    'swordCost', upgrade_cost::text, 'maxHero', hero_max::text, 'vitalityCost', vitality_cost::text,
    'challenge', state.challenge_started_ms is not null, 'revision', state.revision::text,
    'reward', reward::text, 'result', result,
    'turnDelay', 1050 - mod(greatest(0, now_ms - coalesce(state.challenge_started_ms, state.settled_ms)), 1050),
    'job', state.job, 'skill', skill, 'autoBoss', state.auto_boss, 'gapSeconds', gap_seconds::text, 'pending', pending
  );
end;
$$;
