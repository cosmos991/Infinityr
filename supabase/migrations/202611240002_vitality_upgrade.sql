alter table infinityr_private.progress
  add column vitality numeric not null default 0 check (vitality >= 0);

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
  boss boolean;
  result text := 'sync';
begin
  if save_code is null or save_code !~ '^[0-9a-f]{64}$'
      or action is null or action not in ('create', 'sync', 'upgrade', 'vitality', 'challenge') then
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
  attack := 4 * state.sword + 4;
  hero_max := 54 + 6 * state.sword + 15 * state.vitality;
  hero_hp := hero_max;

  if state.challenge_started_ms is not null then
    play_floor := state.best + 1;
    boss := mod(play_floor, 10) = 0;
    enemy_hp := (12 + 12 * play_floor) * case when boss then 2 else 1 end;
    attack_turns := ceil(enemy_hp / attack);
    loss_turns := ceil(hero_max / (3 + play_floor * case when boss then 4 else 2 end));
    elapsed := (now_ms - state.challenge_started_ms) / 1050;
    fight_turns := least(attack_turns, loss_turns);
    if elapsed >= fight_turns then
      if attack_turns <= loss_turns then
        state.best := play_floor;
        state.paid := 0;
        reward := (5 + play_floor * 3) * case when boss then 3 else 1 end;
        result := 'won';
      else
        result := 'lost';
      end if;
      state.settled_ms := state.challenge_started_ms + fight_turns::bigint * 1050;
      state.challenge_started_ms := null;
    else
      hero_hp := hero_max - elapsed * (3 + play_floor * case when boss then 4 else 2 end);
      enemy_hp := enemy_hp - elapsed * attack;
    end if;
  end if;

  if state.challenge_started_ms is null then
    play_floor := greatest(state.best, 1);
    boss := mod(play_floor, 10) = 0;
    enemy_hp := (12 + 12 * play_floor) * case when boss then 2 else 1 end;
    attack_turns := ceil(enemy_hp / attack);
    elapsed := (now_ms - state.settled_ms) / 1050;
    farm_turns := elapsed + state.paid;
    kills := div(farm_turns, attack_turns);
    state.paid := mod(farm_turns, attack_turns);
    state.settled_ms := state.settled_ms + elapsed * 1050;
    reward := reward + kills * (5 + play_floor * 3) * case when boss then 3 else 1 end;
    if kills > 0 and state.best = 0 then state.best := 1; end if;
    enemy_hp := enemy_hp - state.paid * attack;
  end if;

  state.gold := state.gold + reward;
  upgrade_cost := 18 + 12 * state.sword + div(state.sword * (state.sword - 1), 2);

  vitality_cost := 25 + 10 * state.vitality + state.vitality * state.vitality;

  if action in ('upgrade', 'vitality', 'challenge') then
    if expected_revision is distinct from state.revision::text then
      result := 'stale';
    elsif state.challenge_started_ms is not null then
      result := 'busy';
    elsif action = 'upgrade' and state.gold >= upgrade_cost then
      state.gold := state.gold - upgrade_cost;
      state.sword := state.sword + 1;
      state.paid := 0;
      state.revision := state.revision + 1;
      enemy_hp := (12 + 12 * play_floor) * case when boss then 2 else 1 end;
      hero_max := hero_max + 6;
      hero_hp := hero_max;
      result := 'upgraded';
    elsif action = 'vitality' and state.gold >= vitality_cost then
      state.gold := state.gold - vitality_cost;
      state.vitality := state.vitality + 1;
      state.revision := state.revision + 1;
      hero_max := hero_max + 15;
      hero_hp := hero_max;
      vitality_cost := 25 + 10 * state.vitality + state.vitality * state.vitality;
      result := 'vitality_upgraded';
    elsif action = 'challenge' and state.best > 0 then
      state.challenge_started_ms := now_ms;
      state.revision := state.revision + 1;
      play_floor := state.best + 1;
      enemy_hp := (12 + 12 * play_floor) * case when mod(play_floor, 10) = 0 then 2 else 1 end;
      result := 'challenging';
    end if;
  end if;

  update infinityr_private.progress set
    gold = state.gold, sword = state.sword, vitality = state.vitality, best = state.best, paid = state.paid,
    settled_ms = state.settled_ms, challenge_started_ms = state.challenge_started_ms,
    revision = state.revision
  where save_hash = code_hash;

  return jsonb_build_object(
    'gold', state.gold::text, 'level', state.sword::text, 'best', state.best::text,
    'floor', play_floor::text, 'hp', enemy_hp::text, 'hero', hero_hp::text,
    'maxHero', hero_max::text, 'vitalityCost', vitality_cost::text,
    'challenge', state.challenge_started_ms is not null, 'revision', state.revision::text,
    'reward', reward::text, 'result', result
  );
end;
$$;
