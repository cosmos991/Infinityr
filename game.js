const byId = id => document.getElementById(id);
const turnMs = 1050;
const key = 'slime-hollow-v1';
const places = [
  ['이끼 동굴', '이끼 슬라임', '#91e6a1', '#29463e'],
  ['자수정 광산', '수정 슬라임', '#d09bf9', '#423252'],
  ['잿불 굴', '잿불 슬라임', '#ffa16f', '#502e38']
];
let game = { gold: 0n, level: 1n, best: 0n, paid: 0, at: Date.now() };
try {
  const saved = JSON.parse(localStorage.getItem(key));
  if (saved) {
    const { gold, level, best, paid, at } = saved;
    if (BigInt(gold) >= 0n && BigInt(level) > 0n && BigInt(best) >= 0n &&
        Number.isSafeInteger(at) && at > 0 && Number.isInteger(paid) && paid >= 0) {
      game = { gold: BigInt(gold), level: BigInt(level), best: BigInt(best), paid, at };
    }
  }
} catch {}
const save = () => {
  try {
    localStorage.setItem(key, JSON.stringify(game, (_, value) => typeof value === 'bigint' ? String(value) : value));
  } catch {}
};
const fmt = number => number >= 1000000n
  ? number.toString()[0] + '.' + number.toString().slice(1, 3) + 'e' + (number.toString().length - 1)
  : number.toLocaleString('ko-KR');
const farmingFloor = () => game.best || 1n;
const attack = () => game.level * 4n + 4n;
const cost = () => 18n + 12n * game.level + game.level * (game.level - 1n) / 2n;
function monster(floor) {
  const boss = floor % 10n === 0n;
  const zone = places[Number(((floor - 1n) / 10n) % 3n)];
  return {
    boss, zone, hp: (12n + 12n * floor) * (boss ? 2n : 1n),
    damage: 3n + floor * (boss ? 4n : 2n),
    gold: (5n + floor * 3n) * (boss ? 3n : 1n)
  };
}
const hitsPerKill = enemy => (enemy.hp + attack() - 1n) / attack();
const heroMax = () => 54n + 6n * game.level;
let floor, foe, hp, hero, challenge, nextTurn, effect;
function enter(number, trying = false, now = Date.now()) {
  floor = number;
  foe = monster(floor);
  hp = foe.hp;
  hero = heroMax();
  challenge = trying;
  nextTurn = now + turnMs;
}
function say(message) { byId('message').textContent = message; }
function catchUp(now) {
  const floor = farmingFloor();
  const enemy = monster(floor);
  const turns = BigInt(Math.floor(Math.max(0, now - game.at) / turnMs));
  const hits = hitsPerKill(enemy);
  const total = turns + BigInt(game.paid);
  const kills = total / hits;
  game.paid = Number(total % hits);
  game.gold += kills * enemy.gold;
  if (kills && !game.best) game.best = 1n;
  game.at = Math.min(now, game.at + Number(turns) * turnMs);
  return kills * enemy.gold;
}
function resume() {
  const now = Date.now();
  const reward = catchUp(now);
  if (reward) say('쉬는 동안 자동 사냥으로 +' + fmt(reward) + ' 골드를 모았어요.');
  enter(farmingFloor(), false, now);
  hp -= BigInt(game.paid) * attack();
  nextTurn = game.at + turnMs;
  save();
  render();
}
function render() {
  const target = game.best + 1n;
  for (const [id, value] of Object.entries({
    gold: fmt(game.gold), floor: fmt(floor), biome: foe.zone[0],
    mode: challenge ? '층 공략 중' : '자동 사냥', enemy: foe.boss ? '왕슬라임' : foe.zone[1],
    'hero-hp': fmt(hero) + ' / ' + fmt(heroMax()), 'enemy-hp': fmt(hp) + ' / ' + fmt(foe.hp),
    cost: fmt(cost()) + ' 골드', level: fmt(game.level), attack: fmt(attack()),
    best: game.best ? fmt(game.best) + '층' : '—',
    'challenge-label': challenge ? '도전 중' : '다음 층 도전',
    target: challenge ? fmt(floor) + '층' : fmt(target) + '층'
  })) byId(id).textContent = value;
  byId('hero-bar').style.width = Number(hero * 100n / heroMax()) + '%';
  byId('enemy-bar').style.width = Number(hp * 100n / foe.hp) + '%';
  byId('upgrade').disabled = game.gold < cost();
  byId('challenge').disabled = challenge || !game.best;
}
function tick(now) {
  nextTurn = now + turnMs;
  game.at = now;
  const hit = attack();
  effect = { at: performance.now(), hit, gold: 0n };
  hp = hp > hit ? hp - hit : 0n;
  if (!challenge) game.paid++;
  if (!hp) {
    game.gold += foe.gold;
    game.paid = 0;
    effect.gold = foe.gold;
    if (floor > game.best) {
      game.best = floor;
      say(fmt(floor) + '층 클리어! 이 층에서 자동으로 골드를 모아요.');
    }
    enter(floor, false, now);
  } else if (challenge) {
    hero -= foe.damage;
    if (hero <= 0n) {
      say(fmt(floor) + '층에서 패배했어요. ' + fmt(game.best) + '층에서 다시 골드를 모아요.');
      enter(farmingFloor(), false, now);
      hp -= BigInt(game.paid) * attack();
    }
  }
  save();
  render();
}
byId('upgrade').onclick = () => {
  if (game.gold < cost()) return;
  game.gold -= cost();
  game.level++;
  game.paid = 0;
  if (!challenge) hp = foe.hp;
  hero += 6n;
  say('검을 강화했어요. 공격력 ' + fmt(attack()) + ' (+4)');
  save();
  render();
};
byId('challenge').onclick = () => {
  if (!game.best || challenge) return;
  enter(game.best + 1n, true);
  say(fmt(floor) + '층 도전! 기사가 자동으로 싸워요.');
  render();
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden) save();
  else resume();
});
window.addEventListener('pagehide', save);
window.addEventListener('pageshow', event => { if (event.persisted) resume(); });

const canvas = byId('scene');
const ctx = canvas.getContext('2d');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const knight = [
  '......rrr.......','.......rrr......','.....ooooo......','....ossllso.....',
  '....osllllo.....','....osoooso.....','....ossbbo......','.....oooo....l..',
  '...obbsbbo..ll..','..obsssbbo.llo..','..obslsbbollo...','..obbbsooll.....',
  '...obbboggo.....','...oobboo.......','...osooos.......','...ooo.ooo......'
];
const slime = [
  '........................','........ooooooo.........','......oommmmmmmoo.......',
  '.....ommmhhhhmmmmo......','....ommmhhmmmmmmmmo.....','...ommmmmmmmmmmmmmmo....',
  '..ommmmommmmmmommmmmo...','..ommmmommmmmmommmmmo...','..ommpmmmmmmmmmmmpmmo...',
  '..ommmmmmmmoommmmmmmo...','..odmmmmmmmmmmmmmmddo...','...ooddddddddddddoo.....','.....ooooooooooo........'
];
function rect(x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
}
function sprite(rows, x, y, scale, palette) {
  rows.forEach((row, dy) => [...row].forEach((pixel, dx) => {
    if (palette[pixel]) rect(x + dx * scale, y + dy * scale, scale, scale, palette[pixel]);
  }));
}
function torch(x, t) {
  rect(x, 44, 37, 58, '#2c2033');
  rect(x + 6, 51, 25, 44, '#37283b');
  rect(x + 14, 78, 9, 10, '#785345');
  rect(x + 13, 68, 11, 9, '#ed8550');
  rect(x + 16, 62 + Math.floor(t / 140) % 3, 5, 14, '#ffc376');
  rect(x + 17, 70, 3, 6, '#ffebaa');
}
function draw(t) {
  if (!document.hidden && Date.now() >= nextTurn) tick(Date.now());
  const age = effect ? t - effect.at : Infinity;
  const impact = age < 155 && !reduced.matches;
  const ambientTime = reduced.matches ? 0 : t;
  rect(0, 0, 384, 160, '#151120');
  for (let row = 0; row < 7; row++) {
    for (let column = -1; column < 13; column++) {
      const x = column * 33 + (row % 2) * 16;
      rect(x, row * 16, 31, 14, (column + row * 3) % 5 ? '#20192c' : '#261c34');
      rect(x + 1, row * 16 + 1, 29, 1, '#2a2237');
    }
  }
  for (const x of [25, 323]) torch(x, ambientTime);
  rect(156, 39, 72, 80, '#31273e');
  rect(163, 44, 58, 75, '#221b2d');
  rect(171, 51, 42, 68, '#100d19');
  rect(179, 57, 26, 62, '#0d0b14');
  rect(0, 112, 384, 48, foe.zone[3]);
  for (let x = 0; x < 384; x += 25) {
    rect(x, 115, 22, 3, '#766078');
    rect(x + 8, 131, 21, 2, '#1e1928');
    rect(x + 2, 146, 16, 2, '#242033');
  }
  rect(86, 118, 61, 5, '#14121e');
  rect(231, 118, 64, 5, '#14121e');
  sprite(knight, 86 + (impact ? 23 : 0), 56, 4, {
    o:'#252039', r:'#f27a82', s:'#8588b9', l:'#d7e5ff', b:'#484d81', g:'#f0bd70'
  });
  const scale = foe.boss ? 5 : 3;
  const x = 263 - 12 * scale + (impact ? 5 : 0);
  const y = 120 - slime.length * scale - (Math.floor(ambientTime / 200) % 4 === 1 ? 2 : 0);
  sprite(slime, x, y, scale, {
    o:'#242138', m:impact ? '#f9e8ff' : foe.zone[2], d:'#496572', h:'#f3fff0', p:'#f8b4c5'
  });
  if (foe.boss) sprite(['g...g...g','gg.gg.ggg','ggggggggg','gooooooog','ggggggggg'], x + 37, y - 13, 5, {g:'#ffd276',o:'#a6614f'});
  if (age < 560) {
    if (impact) {
      rect(198, 72, 22, 3, '#fff3cd');
      rect(205, 68, 12, 2, '#fff3cd');
    }
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = effect.gold ? '#ffd482' : '#fff1fa';
    ctx.fillText(effect.gold ? '+' + fmt(effect.gold) + ' G' : '−' + fmt(effect.hit), 262, 54 - (reduced.matches ? 0 : age / 24));
  }
  requestAnimationFrame(draw);
}
resume();
requestAnimationFrame(draw);
