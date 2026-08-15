export const EDGE_TTS_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'

export const CONFIG = {
  PROXY_SERVERS: [
    { name: 'r.jina.ai', template: 'https://r.jina.ai/{url}', headers: { 'X-Return-Format': 'html' } },
    { name: 'allorigins.win', template: 'https://api.allorigins.win/raw?url={url}' },
    { name: 'corsproxy.io', template: 'https://corsproxy.io/?url={url}' },
  ],
  DEFAULT_PROXY_INDEX: 0,
  PROXY_ATTEMPTS: 4,
  PROXY_RETRY_DELAY_MS: 700,
  VOICE_MAP: {
    nanami: 'ja-JP-NanamiNeural',
    keita: 'ja-JP-KeitaNeural',
  },
  RATES: ['-20%', '-10%', '+0%', '+10%', '+20%', '+50%', '+100%'],
  PITCHES: ['-50Hz', '-25Hz', '+0Hz', '+25Hz', '+50Hz'],
  TTS_CHUNK_BYTES: 4096,
  REQUEST_TIMEOUT_MS: 15000,
  LS_PROXY_INDEX: 'kakuyomu_proxy_index',
  LS_PROXY_CUSTOM: 'kakuyomu_proxy_custom',
}
