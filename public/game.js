import { play, newSaveCode } from './cloud.js';

const byId = id => document.getElementById(id);
const key = 'slime-hollow-cloud-v1';
const places = [
  ['이끼 동굴', '이끼 슬라임', '#91e6a1', '#29463e', 'moss'],
  ['자수정 광산', '수정 슬라임', '#d09bf9', '#423252', 'crystal'],
  ['잿불 굴', '잿불 슬라임', '#ffa16f', '#502e38', 'ember']
];
const crown = ['g...g...g','gg.gg.ggg','ggggggggg','gooooooog','ggggggggg'];
const royalSlimes = [
  { name:'왕슬라임', color:null, accent:'#ffd276', crest:crown, motion:'lunge' },
  { name:'수정 왕슬라임', color:'#d59bff', accent:'#e6baff',
    crest:['..g...g..','.ggg.ggg.','ogggggggo','.oggoggo.','..ooooo..'], motion:'shards' },
  { name:'잿불 왕슬라임', color:'#ff956a', accent:'#ffc36b',
    crest:['....g....','..g.gg..g','.ggggoggg','ggoggoggg','.ggggggg.'], motion:'embers' },
  { name:'이끼 왕슬라임', color:'#92e2a3', accent:'#d5f4a0',
    crest:['g.......g','gg..g..gg','.ggggggg.','..gogog..','..ggggg..'], motion:'slam' }
];
let stored = null;
try {
  stored = JSON.parse(localStorage.getItem(key));
} catch {}
const validCode = code => typeof code === 'string' && /^[a-f0-9]{64}$/.test(code);
let saveCode = validCode(stored?.code) ? stored.code : newSaveCode();
let pendingCreate = !validCode(stored?.code) || stored.pending === true;
function remember() {
  try {
    localStorage.setItem(key, JSON.stringify({ code: saveCode, pending: pendingCreate }));
  } catch {}
}
remember();
let game = { gold: 0n, level: 1n, best: 0n, maxHero: 60n, swordCost: 6n, vitalityCost: 25n, autoBoss: false, pending: false, revision: null };
let inFlight = false;
let connected = false;
let scheduled;
let lastSync = 0;
let catchUp = null;

const fmt = number => number >= 1000000n
  ? number.toString()[0] + '.' + number.toString().slice(1, 3) + 'e' + (number.toString().length - 1)
  : number.toLocaleString('ko-KR');
const attack = () => game.level * 4n + 4n;
function monster(floor, boss = false) {
  const zone = places[Number(((floor - 1n) / 10n) % 3n)];
  const decade = floor / 10n;
  const monarch = decade ? royalSlimes[1 + Number((decade - 1n) % 3n)] : royalSlimes[0];
  return { boss, zone, monarch };
}
let floor = 1n, foe = monster(floor), hp = 24n, maxEnemy = 24n, hero = game.maxHero, challenge = false, effect;
let victory;
let farmImpact;
let bossJustBecameWinnable = false;
function say(message, highlight = false) {
  byId('message').textContent = message;
  byId('message').parentElement.dataset.highlight = String(highlight);
}

function bossForecast(floor, power, maxHealth) {
  // Match the server's floor_bosses combat, including Luna attacking first.
  const bossHealth = 24n + 24n * floor;
  const bossDamage = 3n + 4n * floor;
  const hits = (bossHealth + power - 1n) / power;
  const survivable = (maxHealth - 1n) / bossDamage;
  return { hits, survivable, canWin: hits <= survivable + 1n };
}

function render() {
  const preview = bossForecast(floor, attack(), game.maxHero);
  const bossName = foe.monarch.name;
  const shownGold = farmImpact?.phase === 'windup' ? farmImpact.gold : game.gold;
  const shownHp = farmImpact?.phase === 'windup' ? farmImpact.hp : farmImpact ? 0n : hp;
  const newlyWinnable = bossJustBecameWinnable && preview.canWin && !challenge;
  const forecastLabel = newlyWinnable ? '지금 이길 수 있어요' : preview.canWin ? '승리 예상' : '강화 필요';
  const forecast = byId('boss-forecast');
  forecast.hidden = !connected || challenge;
  forecast.dataset.canWin = String(preview.canWin);
  for (const [id, value] of Object.entries({
    gold: fmt(shownGold), floor: fmt(floor), biome: foe.zone[0],
    mode: challenge ? '보스전' : '자동 사냥', enemy: foe.boss ? bossName : foe.zone[1],
    'hero-hp': fmt(hero) + ' / ' + fmt(game.maxHero), 'enemy-hp': fmt(shownHp) + ' / ' + fmt(maxEnemy),
    cost: fmt(shownGold) + ' / ' + fmt(game.swordCost) + '골드', 'vitality-cost': fmt(game.vitalityCost) + ' 골드', level: fmt(game.level), attack: fmt(attack()),
    best: game.best ? fmt(game.best) + '층' : '—',
    'challenge-label': challenge ? '도전 중' : '보스 도전',
    target: fmt(floor) + '층 ' + bossName,
    'boss-forecast': forecastLabel + ' · 처치까지 ' +
      fmt(preview.hits) + '회 공격 · 피격 ' + fmt(preview.survivable) + '회 생존'
  })) byId(id).textContent = value;
  byId('hero-bar').style.width = Number(hero * 100n / game.maxHero) + '%';
  byId('enemy-bar').style.width = Number(shownHp * 100n / maxEnemy) + '%';
  const busy = !connected || inFlight || game.pending;
  byId('auto-boss').checked = game.autoBoss;
  byId('auto-boss').disabled = busy;
  const upgrade = byId('upgrade');
  const ready = shownGold >= game.swordCost;
  const funded = ready ? game.swordCost : shownGold;
  byId('upgrade-fill').style.width = Number(funded * 1000n / game.swordCost) / 10 + '%';
  upgrade.dataset.ready = String(ready);
  upgrade.disabled = busy || challenge || !ready;
  byId('vitality').disabled = busy || challenge || game.gold < game.vitalityCost;
  const challengeButton = byId('challenge');
  challengeButton.classList.toggle('newly-winnable', newlyWinnable);
  challengeButton.disabled = busy || challenge;
  byId('copy-save').disabled = pendingCreate;
  byId('reset-save').disabled = busy;
}

function updateFromServer(data, returning, animateFarming = false) {
  const previousGold = game.gold;
  const previousBest = game.best;
  const previousHp = hp;
  const previousHero = hero;
  const previousFoe = foe;
  const previousFloor = floor;
  game = { gold: BigInt(data.gold), level: BigInt(data.level), best: BigInt(data.best),
    maxHero: BigInt(data.maxHero), swordCost: BigInt(data.swordCost), vitalityCost: BigInt(data.vitalityCost), autoBoss: data.autoBoss, pending: data.pending, revision: data.revision };
  floor = BigInt(data.floor);
  foe = monster(floor, data.challenge);
  hp = BigInt(data.hp);
  maxEnemy = BigInt(data.maxEnemy);
  hero = BigInt(data.hero);
  challenge = data.challenge;
  if (floor !== previousFloor || challenge) {
    bossJustBecameWinnable = false;
  } else if (!returning && (data.result === 'upgraded' || data.result === 'vitality_upgraded')) {
    const priorAttack = data.result === 'upgraded' ? attack() - 4n : attack();
    const priorHealth = data.result === 'vitality_upgraded' ? game.maxHero - 15n : game.maxHero;
    if (!bossForecast(floor, priorAttack, priorHealth).canWin && bossForecast(floor, attack(), game.maxHero).canWin) {
      bossJustBecameWinnable = true;
    }
  }
  const reward = BigInt(data.reward);
  if (animateFarming && !returning && !reduced.matches && !previousFoe.boss
      && !foe.boss && floor === previousFloor && (reward || hp < previousHp)) {
    farmImpact = { phase: 'windup', at: performance.now(), gold: previousGold, hp: previousHp, fatal: reward > 0n };
  } else if (!animateFarming || returning || floor !== previousFloor || foe.boss) {
    farmImpact = undefined;
  }
  const counter = previousFoe.boss && (data.result === 'lost' || (challenge && hero < previousHero));
  if (!returning && (counter || reward || (floor === previousFloor && foe.boss === previousFoe.boss && hp < previousHp))) {
    effect = {
      at: farmImpact?.phase === 'windup' ? farmImpact.at : performance.now(), hit: attack(), gold: reward, counter: counter ? previousFoe.monarch : null,
      defeated: reward ? (data.result === 'won' ? monster(game.best, true) : monster(floor)) : null
    };
  }
  if (returning) return;
  if (game.best > previousBest) {
    victory = { at: performance.now(), hit: attack(), gold: reward,
      defeated: monster(game.best, true) };
    byId('clear-banner').textContent = fmt(game.best) + '층 클리어!';
  }
  if (data.result === 'won') say(fmt(floor) + '층 해금! ' + (challenge ? '보스 자동 도전 중이에요.' : '새 층에서 자동 사냥을 시작했어요.'), true);
  else if (data.result === 'lost') say('보스에게 패배했어요. ' + fmt(floor) + '층에서 사냥을 재개해요.');
  else if (data.result === 'challenging') say(fmt(floor) + '층 ' + foe.monarch.name + '에게 도전해요.');
  else if (data.result === 'upgraded') {
    const before = bossForecast(floor, attack() - 4n, game.maxHero).hits;
    const after = bossForecast(floor, attack(), game.maxHero).hits;
    say(before > after
      ? '검 강화! 보스 처치까지 ' + fmt(before) + '타 → ' + fmt(after) + '타'
      : '검 강화! 공격력 ' + fmt(attack()) + ' (+4)', true);
  }
  else if (data.result === 'vitality_upgraded') say('체력을 강화했어요. 최대 체력 ' + fmt(game.maxHero) + ' (+15)');
  else if (data.result === 'auto_on') say('이길 수 있는 보스에 자동으로 도전해요.');
  else if (data.result === 'auto_off') say('보스 자동 도전을 껐어요.');
  else if (data.result === 'stale') say('다른 탭이나 기기의 최신 진행을 불러왔어요.');
  else if (!lastSync) say('슬라임을 사냥하고 보스를 쓰러뜨리면 다음 층이 열려요.');
}

async function synchronize(action = 'sync', targetCode = null) {
  if (inFlight) return;
  clearTimeout(scheduled);
  inFlight = true;
  render();
  const priorConnection = connected;
  let nextTurnDeadline;
  try {
    const command = !targetCode && pendingCreate ? 'create' : action;
    const data = await play(targetCode ?? saveCode, command, game.revision);
    nextTurnDeadline = performance.now() + data.turnDelay;
    if (targetCode) {
      saveCode = targetCode;
      catchUp = null;
      byId('return-summary').hidden = true;
    }
    pendingCreate = false;
    remember();
    const gap = BigInt(data.gapSeconds);
    if (!catchUp && (gap >= 8n || data.pending)) catchUp = { gap, gold: 0n };
    updateFromServer(data, Boolean(catchUp), priorConnection && action === 'sync' && !targetCode);
    if (catchUp) {
      catchUp.gold += BigInt(data.reward);
      if (!data.pending) {
        const hours = catchUp.gap / 3600n;
        const minutes = catchUp.gap / 60n % 60n;
        const seconds = catchUp.gap % 60n;
        const time = [hours && fmt(hours) + '시간', minutes && fmt(minutes) + '분', !hours && seconds && fmt(seconds) + '초']
          .filter(Boolean).join(' ');
        const cleared = game.best ? '최고 ' + fmt(game.best) + '층 클리어' : '클리어한 층 없음';
        byId('return-summary-text').textContent = (time ? '방치 ' + time + ' · ' : '') +
          '골드 +' + fmt(catchUp.gold) + ' · ' + cleared;
        byId('return-summary').hidden = false;
        say('방치 보상을 정산했어요.');
        catchUp = null;
      }
    }
    connected = true;
    lastSync = performance.now();
    byId('save-status').textContent = '저장됨';
    if (targetCode) {
      effect = undefined;
      victory = undefined;
      bossJustBecameWinnable = false;
      const message = action === 'create'
        ? '진행을 초기화했어요. 1층에서 새로 시작해요.'
        : '저장한 던전 진행을 불러왔어요.';
      say(message);
      byId('save-message').textContent = message;
      byId('save-input').value = '';
    }
  } catch (error) {
    connected = Boolean(targetCode && priorConnection);
    if (targetCode) {
      byId('save-message').textContent = action === 'create'
        ? '초기화에 실패했어요. 잠시 후 다시 시도해 주세요.'
        : error.message;
    } else {
      byId('save-status').textContent = '재연결 중';
      say('서버 연결을 확인하고 다시 시도할게요.');
    }
  } finally {
    inFlight = false;
    render();
    if (!document.hidden) {
      const turnDelay = Number.isFinite(nextTurnDeadline) ? Math.max(30, nextTurnDeadline - performance.now()) : 1050;
      scheduled = setTimeout(synchronize, connected ? (game.pending ? 25 : turnDelay) : 5000);
    }
  }
}

byId('auto-boss').onchange = event => synchronize(event.target.checked ? 'auto_on' : 'auto_off');
byId('dismiss-summary').onclick = () => { byId('return-summary').hidden = true; };
byId('upgrade').onclick = () => synchronize('upgrade');
byId('vitality').onclick = () => synchronize('vitality');
byId('challenge').onclick = () => synchronize('challenge');
byId('copy-save').onclick = async () => {
  try {
    await navigator.clipboard.writeText(saveCode);
    byId('save-message').textContent = '저장 코드를 복사했어요.';
  } catch {
    byId('save-input').value = saveCode;
    byId('save-input').select();
    byId('save-message').textContent = '선택된 코드를 직접 복사하세요.';
  }
};
byId('reset-save').onclick = () => {
  if (inFlight || !connected) return;
  if (window.confirm('1층에서 새로 시작할까요? 기존 진행으로 돌아가려면 지금 쓰는 저장 코드가 필요해요.')) {
    synchronize('create', newSaveCode());
  }
};
byId('restore-save').onsubmit = event => {
  event.preventDefault();
  const code = byId('save-input').value.trim().toLowerCase();
  if (!validCode(code)) {
    byId('save-message').textContent = '64자리 저장 코드를 입력하세요.';
    return;
  }
  if (inFlight) {
    byId('save-message').textContent = '저장이 끝나면 다시 눌러 주세요.';
    return;
  }
  synchronize('sync', code);
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(scheduled);
  else synchronize();
});
window.addEventListener('pageshow', event => { if (event.persisted) synchronize(); });

const canvas = byId('scene');
const ctx = canvas.getContext('2d');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const luna = new Image();
luna.src = new URL('./art/luna.webp', import.meta.url);
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
const fragments = [
  [-56,-18,4], [-42,-37,5], [-28,-48,3], [-13,-39,6],
  [6,-49,4], [21,-38,5], [37,-43,3], [54,-22,5],
  [-36,-11,3], [28,-14,4], [6,-24,3]
];

function drawEnemy(age, impact, t, activeEffect, celebrating) {
  const defeated = !reduced.matches && activeEffect?.defeated;
  if (celebrating && !reduced.matches && age >= 380) return;
  if (defeated && age >= 90 && age < 380) {
    const progress = (age - 90) / 290;
    const spread = defeated.boss ? 1.35 : 1;
    ctx.save();
    ctx.globalAlpha = 1 - progress;
    fragments.forEach(([dx, dy, size], index) => {
      const x = 263 + dx * spread * (0.38 + progress);
      const y = 108 + dy * progress * spread + 24 * progress ** 2;
      const color = index % 4 === 0 ? (defeated.boss ? defeated.monarch.accent : '#f3fff0') : defeated.zone[2];
      rect(x, y, size, size, color);
    });
    ctx.restore();
    return;
  }

  const collapsing = defeated && age < 90;
  const enemy = collapsing ? defeated : foe;
  const scale = enemy.boss ? 5 : 3;
  const counterAge = age - (counterDelay - strikeWindup);
  const counter = !reduced.matches && counterAge >= 0 && counterAge < 300 ? activeEffect?.counter : null;
  const pulse = counter ? Math.sin(Math.PI * counterAge / 300) : 0;
  const lunge = counter?.motion === 'lunge' ? pulse * 32 : 0;
  const jump = counter?.motion === 'slam' ? pulse * 18 : 0;
  const x = 263 - 12 * scale + (impact && !defeated ? 5 : 0) - lunge;
  const y = 120 - slime.length * scale - (Math.floor(t / 200) % 4 === 1 ? 2 : 0) - jump;
  ctx.save();
  if (collapsing) {
    ctx.translate(0, 120);
    ctx.scale(1, 1 - 0.7 * Math.max(0, age) / 90);
    ctx.translate(0, -120);
  } else if (defeated && age < 510) {
    ctx.globalAlpha = (age - 380) / 130;
  }
  sprite(slime, x, y, scale, {
    o:'#242138', m:impact ? '#f9e8ff' : (enemy.boss && enemy.monarch.color) || enemy.zone[2], d:'#496572', h:'#f3fff0', p:'#f8b4c5'
  });
  if (enemy.boss) {
    sprite(enemy.monarch.crest, x + 37, y - 13, 5, {g:enemy.monarch.accent,o:'#674659'});
  }
  ctx.restore();
}

function drawCounter(age, activeEffect) {
  const counter = activeEffect?.counter;
  if (!counter || reduced.matches || age < 0 || age >= 360 || counter.motion === 'lunge') return;
  const progress = age / 360;
  ctx.save();
  ctx.globalAlpha = 1 - progress;
  for (let i = 0; i < 6; i++) {
    const x = 251 - (115 + 12 * i) * progress;
    if (counter.motion === 'shards') {
      rect(x, 57 + 8 * i, 9, 3, counter.accent);
      rect(x + 4, 54 + 8 * i, 3, 9, '#fff0ff');
    } else if (counter.motion === 'embers') {
      const y = 108 - 5 * i - 38 * Math.sin(Math.PI * progress);
      rect(x, y, 5 + i % 3, 5 + i % 3, i % 2 ? '#ff7853' : counter.accent);
    } else {
      rect(x - 9 * i, 112 - (i % 2) * 3, 10 + i, 4, counter.accent);
    }
  }
  ctx.restore();
}

const strikeWindup = 85;
const counterDelay = 215;
const strikePoses = [
  // Milliseconds, horizontal offset, lift, and lean in radians.
  [0, 0, 0, 0],
  [strikeWindup, -9, 1, -0.09],
  [150, 31, 6, 0.15],
  [215, 25, 2, 0.08],
  [385, 0, 0, 0]
];

function lunaPose(age, time, tookHit) {
  const breath = Math.sin(time / 390);
  let pose = { x: 0, lift: 0, lean: 0, height: 94 + breath * 1.2 };
  const next = strikePoses.findIndex(([at]) => age < at);
  if (next > 0) {
    const [start, x, lift, lean] = strikePoses[next - 1];
    const [end, toX, toLift, toLean] = strikePoses[next];
    const t = (age - start) / (end - start);
    const blend = t * t * (3 - 2 * t);
    pose = { x: x + (toX - x) * blend, lift: lift + (toLift - lift) * blend,
      lean: lean + (toLean - lean) * blend, height: 94 };
  }
  if (tookHit && age >= counterDelay && age < counterDelay + 180) {
    const recoil = Math.sin(Math.PI * (age - counterDelay) / 180);
    pose.x -= recoil * 16;
    pose.lean -= recoil * 0.15;
    pose.height -= recoil * 3;
  }
  return pose;
}

function drawLuna(age, time, activeEffect) {
  const pose = lunaPose(reduced.matches ? Infinity : age, time, Boolean(activeEffect?.counter));
  const x = 117 + pose.x;
  rect(x - 20, 117, 47, 6, '#14121e');
  if (!luna.naturalWidth) return;

  const width = pose.height * luna.naturalWidth / luna.naturalHeight;
  ctx.save();
  ctx.translate(x, 120 - pose.lift);
  ctx.rotate(pose.lean);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(luna, -width / 2, -pose.height, width, pose.height);
  ctx.restore();
}

function drawSwordSweep(age) {
  if (reduced.matches || age < 0 || age >= 150) return;
  const progress = age / 150;
  const x = 157 + 28 * progress;
  ctx.save();
  ctx.globalAlpha = 1 - progress;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, 47);
  ctx.quadraticCurveTo(x + 61, 43, x + 53, 98);
  ctx.lineWidth = 9 - 5 * progress;
  ctx.strokeStyle = '#c7a6f3';
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#fff5dc';
  ctx.stroke();
  rect(x + 57, 67, 4, 4, '#fff0c7');
  rect(x + 45, 52, 3, 3, '#fff0c7');
  ctx.restore();
}

const dungeonPalettes = {
  moss: ['#111c22','#202f32','#243639','#2b4141','#3c5850'],
  crystal: ['#131229','#23213c','#2c2448','#40345f','#655480'],
  ember: ['#21131d','#30202b','#3b252e','#513039','#805048']
};
const crystals = [
  '......h.......','.....hhl......','.....hll......','..h..hll..h...',
  '.hhb.hll.hhl..','.hlb.hlb.hlb..','.hlb.hlb.hlb..',
  '..hbchlbhlb...','..cbchlbhlbc..','...cbbbcbbc...','...cccccccc...'
];

function crystalCluster(x, y, scale, time) {
  const glow = ctx.createRadialGradient(x + 7 * scale, y + 5 * scale, 1,
    x + 7 * scale, y + 5 * scale, 12 * scale);
  glow.addColorStop(0, '#a277ff60');
  glow.addColorStop(1, '#a277ff00');
  rect(x - 5 * scale, y - 6 * scale, 24 * scale, 24 * scale, glow);
  sprite(crystals, x, y, scale, {h:'#f2ddff',l:'#ba91ff',b:'#7156ba',c:'#49356c'});
  const sparkle = Math.floor((time + x * 7) / 300) % 5;
  rect(x + (2 + sparkle * 2) * scale, y - 5 - sparkle * 3, 2, 2, '#eadbff');
}

function drawDungeon(zone, time) {
  const theme = zone[4];
  const [base, stone, darkStone, edge, paving] = dungeonPalettes[theme];
  rect(0, 0, 384, 160, base);
  for (let row = 0; row < 7; row++) {
    for (let column = -1; column < 13; column++) {
      const x = column * 33 + (row % 2) * 16;
      rect(x, row * 16, 31, 14, (column + row * 3) % 5 ? stone : darkStone);
      rect(x + 1, row * 16 + 1, 29, 1, edge);
    }
  }

  rect(156, 39, 72, 80, edge);
  rect(163, 44, 58, 75, darkStone);
  rect(171, 51, 42, 68, base);
  rect(179, 57, 26, 62, '#0d0b14');

  if (theme === 'moss') {
    for (const x of [25, 323]) torch(x, time);
    for (const x of [0, 67, 147, 300, 363]) {
      rect(x, 15, 18, 4, '#37594c');
      rect(x + 3, 19, 4, 13 + x % 8, '#37594c');
      rect(x + 8, 22, 8, 3, '#53785e');
    }
  } else if (theme === 'crystal') {
    crystalCluster(17, 55, 4, time);
    crystalCluster(312, 49, 4, time);
    crystalCluster(173, 12, 2, time);
  } else {
    for (let i = 0; i < 12; i++) {
      const y = 112 - ((Math.floor(time / 34) + 17 * i) % 97);
      rect((29 + i * 61) % 384, y, 2 + i % 2, 2, i % 3 ? '#cf674d' : '#fca163');
    }
  }

  rect(0, 112, 384, 48, zone[3]);
  for (let x = 0; x < 384; x += 25) {
    rect(x, 115, 22, 3, paving);
    rect(x + 8, 131, 21, 2, darkStone);
    rect(x + 2, 146, 16, 2, base);
  }
  if (theme === 'ember') {
    for (let i = 0; i < 16; i++) {
      const x = i * 25 - 4;
      const y = 138 + ((i * 7) % 3) * 3;
      rect(x, y, 26, 6, '#a8403d');
      rect(x, y + 2, 26, 2, '#f86d42');
      const glint = (Math.floor(time / 60) + i * 7) % 23;
      rect(x + glint, y + 2, 5, 1, '#ffbc66');
    }
  }
}

function draw(t) {
  if (farmImpact) {
    const elapsed = t - farmImpact.at;
    if (reduced.matches || elapsed >= strikeWindup + 380) {
      farmImpact = undefined;
      render();
    } else if (elapsed >= strikeWindup && farmImpact.phase === 'windup') {
      if (farmImpact.fatal) farmImpact.phase = 'defeat';
      else farmImpact = undefined;
      render();
    }
  }
  const victoryAge = victory ? t - victory.at : Infinity;
  const celebrating = victoryAge >= 0 && victoryAge < 1200;
  const banner = byId('clear-banner');
  const showBanner = celebrating && (reduced.matches || victoryAge >= 355);
  if (banner.hidden === showBanner) banner.hidden = !showBanner;
  const activeEffect = celebrating ? victory : effect;
  let age = activeEffect ? t - activeEffect.at : Infinity;
  if (celebrating && !reduced.matches && age >= 125) age = Math.max(125, age - 90);
  const hitAge = age - strikeWindup;
  const impact = hitAge >= 0 && hitAge < 115 && !reduced.matches;
  const ambientTime = reduced.matches ? 0 : celebrating ? t - (victoryAge - age) : t;
  drawDungeon((celebrating ? victory.defeated : foe).zone, ambientTime);
  rect(231, 118, 64, 5, '#14121e');
  drawLuna(age, ambientTime, activeEffect);
  drawEnemy(hitAge, impact, ambientTime, activeEffect, celebrating);
  drawSwordSweep(hitAge);
  drawCounter(age - counterDelay, activeEffect);
  if (hitAge >= 0 && hitAge < 560) {
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = activeEffect.gold ? '#ffd482' : '#fff1fa';
    ctx.fillText(activeEffect.gold ? '+' + fmt(activeEffect.gold) + ' G' : '−' + fmt(activeEffect.hit), 262, 54 - (reduced.matches ? 0 : hitAge / 24));
  }
  requestAnimationFrame(draw);
}
synchronize();
requestAnimationFrame(draw);
