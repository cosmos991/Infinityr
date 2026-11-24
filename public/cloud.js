const endpoint = 'https://cixwgmqyxmhayolbdinn.supabase.co/rest/v1/rpc/infinityr_play';
const publishableKey = 'sb_publishable_yBC_dbzmZFSixgepNGF8pg_8_7bUD0d';

export async function play(saveCode, action, expectedRevision = null) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ save_code: saveCode, action, expected_revision: expectedRevision }),
    signal: AbortSignal.timeout(10000)
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error('서버 저장에 연결할 수 없어요.');
    if (data.code === 'P0002') error.message = '이 저장 코드를 찾을 수 없어요.';
    throw error;
  }
  return data;
}

export function newSaveCode() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}
