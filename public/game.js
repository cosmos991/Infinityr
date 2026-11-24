import { play, newSaveCode } from './cloud.js';

const byId = id => document.getElementById(id);
const key = 'slime-hollow-cloud-v1';
const places = [
  ['이끼 동굴', '이끼 슬라임', '#91e6a1', '#29463e'],
  ['자수정 광산', '수정 슬라임', '#d09bf9', '#423252'],
  ['잿불 굴', '잿불 슬라임', '#ffa16f', '#502e38']
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
let game = { gold: 0n, level: 1n, best: 0n, revision: null };
let inFlight = false;
let connected = false;
let scheduled;
let lastSync = 0;

const fmt = number => number >= 1000000n
  ? number.toString()[0] + '.' + number.toString().slice(1, 3) + 'e' + (number.toString().length - 1)
  : number.toLocaleString('ko-KR');
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
const heroMax = () => 54n + 6n * game.level;
let floor = 1n, foe = monster(floor), hp = foe.hp, hero = heroMax(), challenge = false, effect;
function say(message) { byId('message').textContent = message; }

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
  byId('upgrade').disabled = !connected || inFlight || challenge || game.gold < cost();
  byId('challenge').disabled = !connected || inFlight || challenge || !game.best;
  byId('copy-save').disabled = pendingCreate;
  byId('reset-save').disabled = !connected || inFlight;
}

function updateFromServer(data, returning) {
  const previousHp = hp;
  const previousFloor = floor;
  game = { gold: BigInt(data.gold), level: BigInt(data.level), best: BigInt(data.best), revision: data.revision };
  floor = BigInt(data.floor);
  foe = monster(floor);
  hp = BigInt(data.hp);
  hero = BigInt(data.hero);
  challenge = data.challenge;
  const reward = BigInt(data.reward);
  if (!returning && (reward || (floor === previousFloor && hp < previousHp))) {
    effect = { at: performance.now(), hit: attack(), gold: reward };
  }
  if (returning && reward) say('쉬는 동안 +' + fmt(reward) + ' 골드를 모았어요.');
  else if (data.result === 'won') say(fmt(game.best) + '층 클리어! 이 층에서 골드를 모아요.');
  else if (data.result === 'lost') say('도전에 실패했어요. ' + fmt(game.best) + '층에서 사냥을 재개해요.');
  else if (data.result === 'challenging') say(fmt(floor) + '층 도전! 기사가 자동으로 싸워요.');
  else if (data.result === 'upgraded') say('검을 강화했어요. 공격력 ' + fmt(attack()) + ' (+4)');
  else if (data.result === 'stale') say('다른 탭이나 기기의 최신 진행을 불러왔어요.');
  else if (!lastSync) say('슬라임을 쓰러뜨리고 골드를 모아요.');
}

async function synchronize(action = 'sync', targetCode = null) {
  if (inFlight) return;
  clearTimeout(scheduled);
  inFlight = true;
  render();
  const returning = !lastSync || performance.now() - lastSync > 8000;
  const priorConnection = connected;
  try {
    const command = !targetCode && pendingCreate ? 'create' : action;
    const data = await play(targetCode ?? saveCode, command, game.revision);
    if (targetCode) saveCode = targetCode;
    pendingCreate = false;
    remember();
    updateFromServer(data, returning && !targetCode);
    connected = true;
    lastSync = performance.now();
    byId('save-status').textContent = '저장됨';
    if (targetCode) {
      effect = undefined;
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
    if (!document.hidden) scheduled = setTimeout(synchronize, connected ? (challenge ? 1050 : 2100) : 5000);
  }
}

byId('upgrade').onclick = () => synchronize('upgrade');
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
synchronize();
requestAnimationFrame(draw);
